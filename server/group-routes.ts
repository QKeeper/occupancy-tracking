import type { Express, Request, Response, NextFunction } from "express";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import crypto from "crypto";
import { usernameSchema } from "./validation";

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const INVITE_CHARS = "23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ";
export function generateInviteCode(length = 8): string {
  const bytes = crypto.randomBytes(length);
  let code = "";
  for (let i = 0; i < length; i++) {
    code += INVITE_CHARS[bytes[i] % INVITE_CHARS.length];
  }
  return code;
}

const idSchema = z.coerce.number().int().positive();
const inviteCodeSchema = z.string().trim().min(3).max(32).regex(/^[a-zA-Z0-9_-]+$/);

export function installGroupRoutes(app: Express, pool: Pool, broadcast: (type: string, payload: any) => void) {
  // Authorization and mutation share a transaction and a group-row lock.
  const route = (method: "post" | "put" | "delete", url: string,
    action: (c: PoolClient, req: Request, actor: number, group: any) => Promise<any>, access: "owner" | "member" | "self" | "create") => {
    app[method](url, async (req: Request, res: Response, next: NextFunction) => {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        const actor = res.locals.userId;
        let group: any;
        if (access !== "create") {
          const groupId = idSchema.parse(req.params.groupId);
          group = (await c.query("SELECT * FROM groups WHERE id=$1 FOR UPDATE", [groupId])).rows[0];
          if (!group) throw new HttpError(404, "Группа не найдена");
          if (access === "owner" && group.owner_id !== actor) throw new HttpError(403, "Доступно только владельцу группы");
          if (access === "member") {
            const member = await c.query("SELECT 1 FROM group_members WHERE group_id=$1 AND user_id=$2 AND status='accepted'", [groupId, actor]);
            if (!member.rows.length) throw new HttpError(403, "Нужно состоять в группе");
          }
        }
        const result = await action(c, req, actor, group);
        await c.query("COMMIT");
        res.json(result);
        broadcast("group_updated", { groupId: group?.id ?? result?.id ?? result?.group_id });
      } catch (e) { await c.query("ROLLBACK"); next(e); }
      finally { c.release(); }
    });
  };

  // Public endpoint to preview group details before joining via invite deep link
  app.get("/api/invites/:code", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const code = inviteCodeSchema.parse(req.params.code);
      const { rows: groups } = await pool.query(
        `SELECT g.id, g.name, g.description, g.invite_code, g.owner_id,
                u.display_name as owner_name, u.username as owner_username,
                u.avatar_url as owner_avatar_url, u.avatar_color as owner_avatar_color
         FROM groups g
         LEFT JOIN users u ON g.owner_id = u.id
         WHERE g.invite_code = $1`,
        [code]
      );

      if (!groups.length) {
        return res.status(404).json({ error: "Приглашение не найдено или срок его действия истёк" });
      }

      const group = groups[0];
      const actor = res.locals.userId;

      const { rows: members } = await pool.query(
        `SELECT gm.user_id, u.username, u.display_name, u.avatar_color, u.avatar_url
         FROM group_members gm
         JOIN user_profiles u ON gm.user_id = u.id
         WHERE gm.group_id = $1 AND gm.status = 'accepted'
         ORDER BY gm.joined_at ASC`,
        [group.id]
      );

      let myStatus: string | null = null;
      if (actor) {
        const myMembership = (await pool.query(
          "SELECT status FROM group_members WHERE group_id = $1 AND user_id = $2",
          [group.id, actor]
        )).rows[0];
        if (myMembership) {
          myStatus = myMembership.status;
        }
      }

      res.json({
        id: group.id,
        name: group.name,
        description: group.description || "",
        invite_code: group.invite_code,
        owner: {
          id: group.owner_id,
          name: group.owner_name,
          username: group.owner_username,
          avatar_url: group.owner_avatar_url,
          avatar_color: group.owner_avatar_color,
        },
        members_count: members.length,
        members_preview: members.slice(0, 8).map(m => ({
          user_id: m.user_id,
          username: m.username,
          display_name: m.display_name,
          avatar_color: m.avatar_color,
          avatar_url: m.avatar_url,
        })),
        my_status: myStatus,
      });
    } catch (err) { next(err); }
  });

  // Join group via invite code
  route("post", "/api/invites/:code/join", async (c, req, actor) => {
    const code = inviteCodeSchema.parse(req.params.code);
    const group = (await c.query("SELECT * FROM groups WHERE invite_code = $1 FOR UPDATE", [code])).rows[0];
    if (!group) throw new HttpError(404, "Группа не найдена или ссылка-приглашение недействительна");

    const existing = (await c.query("SELECT status FROM group_members WHERE group_id = $1 AND user_id = $2", [group.id, actor])).rows[0];
    if (existing) {
      if (existing.status === "accepted") {
        return { ok: true, group_id: group.id, status: "accepted", already_member: true, message: "Вы уже состоите в этой группе" };
      }
      await c.query("UPDATE group_members SET status = 'accepted' WHERE group_id = $1 AND user_id = $2", [group.id, actor]);
      return { ok: true, group_id: group.id, status: "accepted", message: "Вы вступили в группу" };
    }

    await c.query("INSERT INTO group_members(group_id, user_id, status, invited_by) VALUES($1, $2, 'accepted', $3)", [group.id, actor, group.owner_id]);
    return { ok: true, group_id: group.id, status: "accepted", message: "Вы успешно вступили в группу" };
  }, "create");

  route("post", "/api/groups", async (c, req, actor) => {
    const data = z.object({ name: z.string().trim().min(1).max(128), description: z.string().max(5000).optional(),
      owner_id: z.number().int().positive().optional(), invite_usernames: z.array(usernameSchema).max(100).optional() }).strict().parse(req.body);
    if (data.owner_id !== undefined && data.owner_id !== actor) throw new HttpError(403, "Нельзя создать группу от чужого имени");

    let group: any;
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = generateInviteCode();
      try {
        group = (await c.query("INSERT INTO groups(name,description,owner_id,invite_code) VALUES($1,$2,$3,$4) RETURNING *", [data.name, data.description || "", actor, code])).rows[0];
        break;
      } catch (err: any) {
        if (err.code === "23505" && attempt < 4) continue;
        throw err;
      }
    }
    await c.query("INSERT INTO group_members(group_id,user_id,status,invited_by) VALUES($1,$2,'accepted',$2)", [group.id, actor]);
    for (const username of data.invite_usernames || []) {
      await c.query(`INSERT INTO group_members(group_id,user_id,status,invited_by)
        SELECT $1,id,'pending',$2 FROM users WHERE lower(username)=$3 AND id<>$2 ON CONFLICT DO NOTHING`, [group.id, actor, username]);
    }
    return group;
  }, "create");

  // Reset/regenerate group invite code (owner only)
  route("post", "/api/groups/:groupId/reset-invite", async (c, _req, _actor, group) => {
    let updated: any;
    for (let attempt = 0; attempt < 5; attempt++) {
      const newCode = generateInviteCode();
      try {
        updated = (await c.query("UPDATE groups SET invite_code = $1 WHERE id = $2 RETURNING *", [newCode, group.id])).rows[0];
        break;
      } catch (err: any) {
        if (err.code === "23505" && attempt < 4) continue;
        throw err;
      }
    }
    return { ok: true, id: group.id, invite_code: updated.invite_code };
  }, "owner");

  route("post", "/api/groups/:groupId/invite", async (c, req, actor, group) => {
    const data = z.object({ username: usernameSchema, invited_by: z.number().int().positive().optional() }).strict().parse(req.body);
    if (data.invited_by !== undefined && data.invited_by !== actor) throw new HttpError(403, "Нельзя приглашать от чужого имени");
    const target = (await c.query("SELECT id,username,display_name,avatar_color FROM users WHERE lower(username)=$1", [data.username])).rows[0];
    if (!target) throw new HttpError(404, "Пользователь не найден");
    const inserted = await c.query("INSERT INTO group_members(group_id,user_id,status,invited_by) VALUES($1,$2,'pending',$3) ON CONFLICT DO NOTHING RETURNING user_id", [group.id, target.id, actor]);
    if (!inserted.rows.length) throw new HttpError(409, "Пользователь уже приглашён или состоит в группе");
    return { message: "Приглашение отправлено", user: target, status: "pending" };
  }, "member");
  route("post", "/api/groups/:groupId/respond", async (c, req, actor, group) => {
    const data = z.object({ user_id: z.number().int().positive().optional(), action: z.enum(["accept", "decline"]) }).strict().parse(req.body);
    if (data.user_id !== undefined && data.user_id !== actor) throw new HttpError(403, "Нельзя отвечать за другого пользователя");
    const result = data.action === "accept"
      ? await c.query("UPDATE group_members SET status='accepted' WHERE group_id=$1 AND user_id=$2 AND status='pending' RETURNING user_id", [group.id, actor])
      : await c.query("DELETE FROM group_members WHERE group_id=$1 AND user_id=$2 AND status='pending' RETURNING user_id", [group.id, actor]);
    if (!result.rows.length) throw new HttpError(409, "Нет ожидающего приглашения");
    return { status: data.action === "accept" ? "accepted" : "declined" };
  }, "self");
  route("put", "/api/groups/:groupId", async (c, req, _actor, group) => {
    const data = z.object({ name: z.string().trim().min(1).max(128), description: z.string().max(5000).optional() }).strict().parse(req.body);
    return (await c.query("UPDATE groups SET name=$1,description=COALESCE($2,description) WHERE id=$3 RETURNING *", [data.name, data.description ?? null, group.id])).rows[0];
  }, "owner");
  route("delete", "/api/groups/:groupId/members/:targetUserId", async (c, req, actor, group) => {
    const target = idSchema.parse(req.params.targetUserId);
    if (actor !== target && actor !== group.owner_id) throw new HttpError(403, "Нельзя удалять других участников");
    const result = await c.query("DELETE FROM group_members WHERE group_id=$1 AND user_id=$2 RETURNING user_id", [group.id, target]);
    if (!result.rows.length) throw new HttpError(404, "Участник не найден");
    if (target === group.owner_id) {
      const next = (await c.query("SELECT user_id FROM group_members WHERE group_id=$1 AND status='accepted' ORDER BY joined_at,user_id LIMIT 1", [group.id])).rows[0];
      if (next) await c.query("UPDATE groups SET owner_id=$1 WHERE id=$2", [next.user_id, group.id]);
      else await c.query("DELETE FROM groups WHERE id=$1", [group.id]);
    }
    return { ok: true };
  }, "self");
  route("post", "/api/groups/:groupId/transfer-owner", async (c, req, _actor, group) => {
    const data = z.object({ new_owner_id: z.number().int().positive() }).strict().parse(req.body);
    const member = await c.query("SELECT 1 FROM group_members WHERE group_id=$1 AND user_id=$2 AND status='accepted'", [group.id, data.new_owner_id]);
    if (!member.rows.length) throw new HttpError(400, "Новый владелец должен состоять в группе");
    return (await c.query("UPDATE groups SET owner_id=$1 WHERE id=$2 RETURNING *", [data.new_owner_id, group.id])).rows[0];
  }, "owner");
  route("delete", "/api/groups/:groupId", async (c, _req, _actor, group) => {
    await c.query("DELETE FROM groups WHERE id=$1", [group.id]); return { ok: true };
  }, "owner");
}
