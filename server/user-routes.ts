import type { Express } from "express";
import type { Pool } from "pg";
import type { TimelineStyleConfig } from "../src/types";
import { z } from "zod";
import { dateSchema, overrideSchema, profileSchema, revisionSchema, scheduleFieldsSchema, scheduleSchema } from "./validation";

export const USER_COLUMNS = "id, username, display_name, avatar_color, avatar_url, banner_url, timeline_style, member_orders, schedule_config, overrides, revision, created_at";
export function installUserRoutes(app: Express, pool: Pool, broadcast: (type: string, payload: any) => void,
  saveImage: (value: string | null | undefined, kind: "avatar" | "banner") => string | null,
  normalizeStyle: (style: TimelineStyleConfig) => Promise<TimelineStyleConfig>) {
  app.get("/api/auth/me", async (_req, res, next) => {
    try { res.json((await pool.query(`SELECT ${USER_COLUMNS} FROM users WHERE id=$1`, [res.locals.userId])).rows[0]); }
    catch (e) { next(e); }
  });
  app.put("/api/users/:id", async (req, res, next) => {
    try {
      const { revision, ...changes } = profileSchema.parse(req.body);
      if (changes.timeline_style) changes.timeline_style = await normalizeStyle(changes.timeline_style);
      if (!Object.keys(changes).length) return res.status(400).json({ error: "Нет изменений" });
      const params: unknown[] = [];
      const sets = Object.entries(changes).map(([key, value]) => {
        let stored: unknown = value;
        if (key === "avatar_url" || key === "banner_url") stored = saveImage(value as string | null, key === "avatar_url" ? "avatar" : "banner");
        if (["timeline_style", "schedule_config", "overrides"].includes(key)) stored = JSON.stringify(value);
        params.push(stored);
        // Keys are restricted by the strict profile schema, never raw input.
        return `${key}=$${params.length}`;
      });
      params.push(res.locals.userId, revision);
      const { rows } = await pool.query(`UPDATE users SET ${sets.join(",")}, revision=revision+1 WHERE id=$${params.length-1} AND revision=$${params.length} RETURNING ${USER_COLUMNS}`, params);
      if (!rows.length) return res.status(409).json({ error: "Данные уже изменились. Обновите их перед сохранением" });
      res.json(rows[0]); broadcast("schedule_updated", { userId: res.locals.userId });
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
  // Compare the previous value of this day, not the whole user revision:
  // parallel edits to different dates succeed; stale edits to the same date fail.
  for (const method of ["put", "delete"] as const) {
    app[method]("/api/users/:id/overrides/:date", async (req, res, next) => {
      try {
        const date = dateSchema.parse(req.params.date);
        const schema = method === "put"
          ? z.object({ expectedOverride: overrideSchema.nullable(), override: overrideSchema }).strict()
          : z.object({ expectedOverride: overrideSchema.nullable() }).strict();
        const body = schema.parse(req.body);
        const nextOverride = "override" in body ? body.override : null;
        const sql = method === "put"
          ? "jsonb_set(overrides,ARRAY[$1]::text[],$2::jsonb,true)"
          : "overrides - $1::text";
        const { rows } = await pool.query(`UPDATE users SET overrides=${sql},revision=revision+1
          WHERE id=$3 AND $2::jsonb IS NOT NULL AND COALESCE(overrides -> $1::text,'null'::jsonb)=$4::jsonb
          RETURNING ${USER_COLUMNS}`,
          [date, JSON.stringify(nextOverride), res.locals.userId, JSON.stringify(body.expectedOverride)]
        );
        if (!rows.length) return res.status(409).json({ error: "Этот день уже изменён в другой вкладке. Обновите данные" });
        broadcast("schedule_updated", { userId: res.locals.userId, dateStr: date });
        res.json({ ok: true, date, override: nextOverride, user: rows[0] });
      } catch (e) { next(e); }
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
      const result = await client.query(`UPDATE users SET schedule_config=$1,revision=revision+1 WHERE id=$2 RETURNING ${USER_COLUMNS}`, [JSON.stringify(config), res.locals.userId]);
      await client.query("COMMIT");
      res.json(result.rows[0]); broadcast("schedule_updated", { userId: res.locals.userId });
    } catch (e) { await client.query("ROLLBACK"); next(e); }
    finally { client.release(); }
  });
}
