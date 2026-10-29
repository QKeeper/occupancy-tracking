import { replaceManualDay } from "./manual-overrides";
import { HttpError } from "./group-routes";
import type { Express } from "express";
import type { Pool } from "pg";
import type { TimelineStyleConfig } from "../src/types";
import { z } from "zod";
import { dateSchema, overrideSchema, profileSchema, revisionSchema, scheduleFieldsSchema, scheduleSchema } from "./validation";

export const USER_COLUMNS = "id, username, display_name, avatar_color, avatar_url, banner_url, timeline_style, member_orders, schedule_config, overrides, revision, created_at, time_zone, is_admin, is_super_admin, timeline_groups";
export function areOverridesEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (!a && !b) return true;
  if (!a || !b) return false;
  if (a.status !== b.status) return false;
  const noteA = (a.note ?? "").trim();
  const noteB = (b.note ?? "").trim();
  if (noteA !== noteB) return false;
  const defaultTz = "Asia/Yekaterinburg";
  const tzA = (!a.timeZone || a.timeZone === defaultTz) ? "" : a.timeZone;
  const tzB = (!b.timeZone || b.timeZone === defaultTz) ? "" : b.timeZone;
  if (tzA !== tzB) return false;
  const slotsA = Array.isArray(a.slots) ? a.slots : [];
  const slotsB = Array.isArray(b.slots) ? b.slots : [];
  if (slotsA.length !== slotsB.length) return false;
  for (let i = 0; i < slotsA.length; i++) {
    const sA = slotsA[i];
    const sB = slotsB[i];
    if (!sA || !sB || sA.start !== sB.start || sA.end !== sB.end) return false;
  }
  return true;
}

export function installUserRoutes(app: Express, pool: Pool, broadcast: (type: string, payload: any) => void,
  saveImage: (value: string | null | undefined, kind: "avatar" | "banner") => string | null,
  normalizeStyle: (style: TimelineStyleConfig) => Promise<TimelineStyleConfig>) {
  app.get("/api/auth/me", async (_req, res, next) => {
    try { res.json((await pool.query(`SELECT ${USER_COLUMNS} FROM user_profiles WHERE id=$1`, [res.locals.userId])).rows[0]); }
    catch (e) { next(e); }
  });
  app.put("/api/users/:id", async (req, res, next) => {
    try {
      const { revision, ...changes } = profileSchema.parse(req.body);
      if (changes.timeline_style) changes.timeline_style = await normalizeStyle(changes.timeline_style);
      if (changes.timeline_groups) {
        for (const g of changes.timeline_groups) {
          if (g.style) g.style = await normalizeStyle(g.style);
        }
        const workGroup = changes.timeline_groups.find((g) => g.id === "work");
        if (workGroup) {
          if (!changes.schedule_config) changes.schedule_config = workGroup.schedule_config;
          if (!changes.timeline_style) changes.timeline_style = workGroup.style;
        }
      }
      if (!Object.keys(changes).length) return res.status(400).json({ error: "Нет изменений" });
      const params: unknown[] = [];
      const sets = Object.entries(changes).map(([key, value]) => {
        let stored: unknown = value;
        if (key === "avatar_url" || key === "banner_url") stored = saveImage(value as string | null, key === "avatar_url" ? "avatar" : "banner");
        if (["timeline_style", "schedule_config", "timeline_groups"].includes(key)) stored = JSON.stringify(value);
        params.push(stored);
        // Keys are restricted by the strict profile schema, never raw input.
        return `${key}=$${params.length}`;
      });
      params.push(res.locals.userId, revision);
      const { rows } = await pool.query(`UPDATE users SET ${sets.join(",")}, revision=revision+1 WHERE id=$${params.length-1} AND revision=$${params.length} RETURNING id`, params);
      if (!rows.length) return res.status(409).json({ error: "Данные уже изменились. Обновите их перед сохранением" });
      const profile = await pool.query(`SELECT ${USER_COLUMNS} FROM user_profiles WHERE id=$1`, [res.locals.userId]);
      res.json(profile.rows[0]); broadcast("schedule_updated", { userId: res.locals.userId });
    } catch (e) { next(e); }
  });
  app.put("/api/users/:id/member-order", async (req, res, next) => {
    try {
      const data = z.object({ groupKey: z.string().min(1).max(128), memberIds: z.array(z.number().int().positive()).max(1000) }).strict().parse(req.body);
      if (new Set(data.memberIds).size !== data.memberIds.length) return res.status(400).json({ error: "Повторяющиеся участники" });
      const { rows } = await pool.query("UPDATE users SET member_orders=jsonb_set(member_orders,ARRAY[$1]::text[],$2::jsonb,true),revision=revision+1 WHERE id=$3 RETURNING member_orders,revision", [data.groupKey, JSON.stringify(data.memberIds), res.locals.userId]);
      res.json({ ok: true, ...rows[0] });
    } catch (e) { next(e); }
  });
  app.get("/api/users/:id/overrides", async (req, res, next) => {
    try {
      if (Number(req.params.id) !== res.locals.userId) throw new HttpError(403, "Можно читать только свои ручные правки");
      const query = z.object({ from: dateSchema.optional(), to: dateSchema.optional() }).strict().parse(req.query);
      if (query.from && query.to && query.from > query.to) throw new HttpError(400, "Начальная дата позже конечной");
      const { rows } = await pool.query(`SELECT to_char(d.override_date,'YYYY-MM-DD') AS date,
        d.status,d.note,d.time_zone AS "timeZone",
        COALESCE(jsonb_agg(jsonb_build_object('id',i.id::text,'startsAt',i.starts_at,'endsAt',i.ends_at,'position',i.position) ORDER BY i.position)
          FILTER(WHERE i.id IS NOT NULL),'[]'::jsonb) AS intervals
        FROM day_overrides d LEFT JOIN occupancy_intervals i USING(user_id,override_date)
        WHERE d.user_id=$1 AND ($2::date IS NULL OR d.override_date >= $2::date)
          AND ($3::date IS NULL OR d.override_date <= $3::date)
        GROUP BY d.user_id,d.override_date ORDER BY d.override_date`,
        [res.locals.userId, query.from ?? null, query.to ?? null]);
      res.json({ days: rows });
    } catch (e) { next(e); }
  });
  app.get("/api/users/:id/overrides/:date", async (req, res, next) => {
    try {
      if (Number(req.params.id) !== res.locals.userId) throw new HttpError(403, "Можно читать только свои ручные правки");
      const date = dateSchema.parse(req.params.date);
      const groupId = typeof req.query.groupId === "string" ? req.query.groupId : "work";
      if (groupId !== "work") {
        const { rows } = await pool.query("SELECT timeline_groups FROM users WHERE id=$1", [res.locals.userId]);
        const groups = Array.isArray(rows[0]?.timeline_groups) ? rows[0].timeline_groups : [];
        const g = groups.find((item: any) => item.id === groupId);
        return res.json({ date, override: g?.overrides?.[date] ?? null });
      }
      const { rows } = await pool.query("SELECT value FROM manual_override_documents WHERE user_id=$1 AND override_date=$2", [res.locals.userId, date]);
      res.json({ date, override: rows[0]?.value ?? null });
    } catch (e) { next(e); }
  });
  // The user lock serializes writes; compare only the requested day so edits to
  // other dates succeed without overwriting one another.
  for (const method of ["put", "delete"] as const) {
    app[method]("/api/users/:id/overrides/:date", async (req, res, next) => {
      let client: import("pg").PoolClient | undefined;
      try {
        const date = dateSchema.parse(req.params.date);
        const schema = method === "put"
          ? z.object({ expectedOverride: overrideSchema.nullable(), override: overrideSchema, groupId: z.string().optional() }).strict()
          : z.object({ expectedOverride: overrideSchema.nullable(), groupId: z.string().optional() }).strict();
        const body = schema.parse(req.body);
        const targetGroupId = body.groupId || "work";
        const nextOverride = "override" in body ? overrideSchema.parse(body.override) : null;
        client = await pool.connect();
        await client.query("BEGIN");
        const { rows: userRows } = await client.query("SELECT id, timeline_groups, timeline_style, schedule_config FROM users WHERE id=$1 FOR UPDATE", [res.locals.userId]);

        if (targetGroupId === "work") {
          const current = await client.query(`SELECT COALESCE((SELECT value FROM manual_override_documents
            WHERE user_id=$1 AND override_date=$2::date),'null'::jsonb) AS doc_value`,
            [res.locals.userId, date]);
          const existingWorkOv = current.rows[0]?.doc_value ?? null;
          if (body.expectedOverride !== undefined && !areOverridesEqual(existingWorkOv, body.expectedOverride)) {
            throw new HttpError(409, "Этот день уже изменён в другой вкладке. Обновите данные");
          }
          await replaceManualDay(client, res.locals.userId, date, nextOverride);
          if (Array.isArray(userRows[0]?.timeline_groups)) {
            const nextGroups = userRows[0].timeline_groups.map((g: any) => {
              if (g.id === "work") {
                const ov = { ...(g.overrides || {}) };
                if (nextOverride) ov[date] = nextOverride; else delete ov[date];
                return { ...g, overrides: ov };
              }
              return g;
            });
            await client.query("UPDATE users SET timeline_groups=$1 WHERE id=$2", [JSON.stringify(nextGroups), res.locals.userId]);
          }
          await client.query("UPDATE users SET revision=revision+1 WHERE id=$1", [res.locals.userId]);
        } else {
          const groups = Array.isArray(userRows[0]?.timeline_groups) && userRows[0].timeline_groups.length > 0 ? [...userRows[0].timeline_groups] : [{ id: "work", name: "График работы", style: userRows[0]?.timeline_style || { bgColor: "#e11d48", patternColor: "#fda4af", patternType: "stripes", symbol: "💼", iconScale: 1 }, schedule_config: userRows[0]?.schedule_config || { mode: "fixed_weekly" }, overrides: {}, is_enabled: true }];
          let groupIdx = groups.findIndex((g: any) => g.id === targetGroupId);
          if (groupIdx < 0 && (targetGroupId === "events" || targetGroupId === "single")) {
            const newGroup = {
              id: targetGroupId,
              name: "Без категории",
              style: {
                bgColor: "#6366f1",
                patternColor: "#a5b4fc",
                patternType: "none",
                symbol: "📌",
                iconScale: 1,
              },
              schedule_config: { mode: "manual" as const },
              overrides: {},
              is_enabled: true,
            };
            groups.push(newGroup);
            groupIdx = groups.length - 1;
          }
          if (groupIdx >= 0) {
            const existingOv = groups[groupIdx].overrides?.[date] ?? null;
            if (body.expectedOverride !== undefined && !areOverridesEqual(existingOv, body.expectedOverride)) {
              throw new HttpError(409, "Этот день уже изменён в другой вкладке. Обновите данные");
            }
            const nextOvMap = { ...(groups[groupIdx].overrides || {}) };
            if (nextOverride) nextOvMap[date] = nextOverride; else delete nextOvMap[date];
            groups[groupIdx] = { ...groups[groupIdx], overrides: nextOvMap };
            await client.query("UPDATE users SET timeline_groups=$1, revision=revision+1 WHERE id=$2", [JSON.stringify(groups), res.locals.userId]);
          } else {
            throw new HttpError(404, "Группа таймлайна не найдена");
          }
        }

        const profile = await client.query(`SELECT ${USER_COLUMNS} FROM user_profiles WHERE id=$1`, [res.locals.userId]);
        await client.query("COMMIT");
        broadcast("schedule_updated", { userId: res.locals.userId, dateStr: date });
        res.json({ ok: true, date, override: nextOverride, user: profile.rows[0] });
      } catch (e) { if (client) await client.query("ROLLBACK"); next(e); }
      finally { client?.release(); }
    });
  }
  app.patch("/api/users/:id/schedule", async (req, res, next) => {
    const client = await pool.connect();
    try {
      const { revision, ...patch } = scheduleFieldsSchema.partial().extend({ revision: revisionSchema }).strict().parse(req.body);
      await client.query("BEGIN");
      const { rows } = await client.query("SELECT schedule_config,revision FROM users WHERE id=$1 FOR UPDATE", [res.locals.userId]);
      if (rows[0].revision !== revision) { await client.query("ROLLBACK"); return res.status(409).json({ error: "Расписание уже изменилось. Обновите данные" }); }
      const config = scheduleSchema.parse({ ...rows[0].schedule_config, ...patch });
      const result = await client.query(`UPDATE users SET schedule_config=$1,revision=revision+1 WHERE id=$2 RETURNING id`, [JSON.stringify(config), res.locals.userId]);
      const profile = await client.query(`SELECT ${USER_COLUMNS} FROM user_profiles WHERE id=$1`, [result.rows[0].id]);
      await client.query("COMMIT");
      res.json(profile.rows[0]); broadcast("schedule_updated", { userId: res.locals.userId });
    } catch (e) { await client.query("ROLLBACK"); next(e); }
    finally { client.release(); }
  });
}
