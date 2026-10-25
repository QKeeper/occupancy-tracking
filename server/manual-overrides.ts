import type { PoolClient } from "pg";
import type { DayOverride } from "../src/types";
import { dateSchema, overrideSchema } from "./validation";

export const getScheduleTimeZone = () => process.env.SCHEDULE_TIMEZONE || "Asia/Yekaterinburg";

/** The caller holds the user's row lock and owns the transaction. */
export async function replaceManualDay(client: PoolClient, userId: number, date: string, value: DayOverride | null) {
  if (value === null) {
    await client.query("DELETE FROM day_overrides WHERE user_id=$1 AND override_date=$2", [userId, date]);
    return;
  }
  const existing = await client.query("SELECT time_zone FROM day_overrides WHERE user_id=$1 AND override_date=$2", [userId, date]);
  const zone = existing.rows[0]?.time_zone || getScheduleTimeZone();
  await client.query(`INSERT INTO day_overrides(user_id,override_date,status,note,time_zone)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(user_id,override_date) DO UPDATE
    SET status=EXCLUDED.status,note=EXCLUDED.note`, [userId, date, value.status, value.note ?? null, zone]);
  await client.query("DELETE FROM occupancy_intervals WHERE user_id=$1 AND override_date=$2", [userId, date]);
  for (const [position, slot] of value.slots.entries()) {
    const minutes = (v: string) => Number(v.slice(0, 2)) * 60 + Number(v.slice(3));
    const start = minutes(slot.start);
    const rawEnd = minutes(slot.end);
    const end = rawEnd < start ? rawEnd + 1440 : rawEnd;
    await client.query(`INSERT INTO occupancy_intervals(user_id,override_date,position,starts_at,ends_at,note,end_as_24)
      VALUES($1,$2,$3,($2::date + $4::int * interval '1 minute') AT TIME ZONE $6,
      ($2::date + $5::int * interval '1 minute') AT TIME ZONE $6,$7,$8)`,
      [userId, date, position, start, end, zone, slot.label ?? null, slot.end === "24:00"]);
  }
}

export async function migrateManualOverrides(client: PoolClient) {
  const scheduleTimeZone = getScheduleTimeZone();
  await client.query("BEGIN");
  try {
    const zone = await client.query("SELECT 1 FROM pg_timezone_names WHERE name=$1", [scheduleTimeZone]);
    if (!zone.rows.length) throw new Error("Invalid SCHEDULE_TIMEZONE");
    await client.query("LOCK TABLE users IN ACCESS EXCLUSIVE MODE");
    await client.query(`
      CREATE TABLE IF NOT EXISTS day_overrides (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        override_date DATE NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('working','partial','free')),
        note TEXT,
        time_zone TEXT NOT NULL,
        PRIMARY KEY(user_id,override_date)
      );
      CREATE TABLE IF NOT EXISTS occupancy_intervals (
        id BIGSERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        override_date DATE NOT NULL,
        position INTEGER NOT NULL CHECK(position>=0),
        starts_at TIMESTAMPTZ NOT NULL,
        ends_at TIMESTAMPTZ NOT NULL CHECK(ends_at>starts_at),
        note TEXT,
        end_as_24 BOOLEAN NOT NULL DEFAULT FALSE,
        FOREIGN KEY(user_id,override_date) REFERENCES day_overrides(user_id,override_date) ON DELETE CASCADE,
        UNIQUE(user_id,override_date,position)
      );
      CREATE INDEX IF NOT EXISTS idx_occupancy_intervals_user_start ON occupancy_intervals(user_id,starts_at);
      CREATE OR REPLACE VIEW manual_override_documents AS
        SELECT d.user_id,d.override_date,
          jsonb_strip_nulls(jsonb_build_object('status',d.status,'note',d.note,'slots',
            COALESCE((SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
              'start',to_char(i.starts_at AT TIME ZONE d.time_zone,'HH24:MI'),
              'end',CASE WHEN i.end_as_24 THEN '24:00' ELSE to_char(i.ends_at AT TIME ZONE d.time_zone,'HH24:MI') END,
              'label',i.note)) ORDER BY i.position)
              FROM occupancy_intervals i WHERE i.user_id=d.user_id AND i.override_date=d.override_date),'[]'::jsonb))) AS value
        FROM day_overrides d;
      CREATE OR REPLACE VIEW user_profiles AS
        SELECT u.id,u.username,u.display_name,u.password,u.avatar_color,u.avatar_url,u.banner_url,
          u.timeline_style,u.member_orders,u.schedule_config,u.revision,u.created_at,
          COALESCE((SELECT jsonb_object_agg(to_char(d.override_date,'YYYY-MM-DD'),d.value)
            FROM manual_override_documents d WHERE d.user_id=u.id),'{}'::jsonb) AS overrides
        FROM users u;
    `);
    const legacy = await client.query("SELECT 1 FROM pg_attribute WHERE attrelid='users'::regclass AND attname='overrides' AND NOT attisdropped");
    if (legacy.rows.length) {
      const { rows } = await client.query("SELECT id,overrides FROM users ORDER BY id");
      for (const row of rows) {
        for (const [date, raw] of Object.entries(row.overrides)) {
          await replaceManualDay(client, row.id, dateSchema.parse(date), overrideSchema.parse(raw));
        }
        const check = await client.query("SELECT overrides=$2::jsonb AS matches FROM user_profiles WHERE id=$1", [row.id, JSON.stringify(row.overrides)]);
        if (!check.rows[0]?.matches) throw new Error(`Manual override migration verification failed for user ${row.id}`);
      }
      // Drop only after every document round-trips exactly; otherwise roll back.
      await client.query("ALTER TABLE users DROP COLUMN overrides");
    }
    await client.query("COMMIT");
  } catch (e) { await client.query("ROLLBACK"); throw e; }
}
