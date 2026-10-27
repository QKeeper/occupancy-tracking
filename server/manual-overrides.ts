import type { PoolClient } from "pg";
import type { DayOverride } from "../src/types";
import { dateSchema, overrideSchema } from "./validation";

export const getScheduleTimeZone = () => process.env.SCHEDULE_TIMEZONE || "Asia/Yekaterinburg";

const STANDARD_SLOT_LABELS = new Set(["работа", "смена"]);

function isMeaningfulLabel(raw: unknown): raw is string {
  if (typeof raw !== "string") return false;
  const trimmed = raw.trim();
  if (!trimmed) return false;
  return !STANDARD_SLOT_LABELS.has(trimmed.toLowerCase());
}

function stripSlotLabelsInScheduleConfig(config: any): { cleaned: any; changed: boolean } {
  if (!config || typeof config !== "object") return { cleaned: config, changed: false };
  let changed = false;
  const next = { ...config };

  if (next.weekly && typeof next.weekly === "object") {
    const nextWeekly: Record<string, any> = {};
    for (const [k, dayObj] of Object.entries<any>(next.weekly)) {
      if (dayObj && typeof dayObj === "object" && Array.isArray(dayObj.slots)) {
        const nextSlots = dayObj.slots.map((s: any) => {
          if (s && typeof s === "object" && "label" in s) {
            changed = true;
            const { label: _removed, ...rest } = s;
            return rest;
          }
          return s;
        });
        nextWeekly[k] = { ...dayObj, slots: nextSlots };
      } else {
        nextWeekly[k] = dayObj;
      }
    }
    next.weekly = nextWeekly;
  }

  if (next.shift && typeof next.shift === "object" && Array.isArray(next.shift.slots)) {
    const nextSlots = next.shift.slots.map((s: any) => {
      if (s && typeof s === "object" && "label" in s) {
        changed = true;
        const { label: _removed, ...rest } = s;
        return rest;
      }
      return s;
    });
    next.shift = { ...next.shift, slots: nextSlots };
  }

  return { cleaned: next, changed };
}

/** The caller holds the user's row lock and owns the transaction. */
export async function replaceManualDay(client: PoolClient, userId: number, date: string, value: DayOverride | null) {
  if (value === null) {
    await client.query("DELETE FROM day_overrides WHERE user_id=$1 AND override_date=$2", [userId, date]);
    return;
  }
  const existing = await client.query("SELECT time_zone FROM day_overrides WHERE user_id=$1 AND override_date=$2", [userId, date]);
  const zone = value.timeZone || existing.rows[0]?.time_zone || getScheduleTimeZone();
  await client.query(`INSERT INTO day_overrides(user_id,override_date,status,note,time_zone)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(user_id,override_date) DO UPDATE
    SET status=EXCLUDED.status,note=EXCLUDED.note,time_zone=EXCLUDED.time_zone`, [userId, date, value.status, value.note ?? null, zone]);
  await client.query("DELETE FROM occupancy_intervals WHERE user_id=$1 AND override_date=$2", [userId, date]);
  for (const [position, slot] of value.slots.entries()) {
    const minutes = (v: string) => Number(v.slice(0, 2)) * 60 + Number(v.slice(3));
    const start = minutes(slot.start);
    const rawEnd = minutes(slot.end);
    const end = rawEnd < start ? rawEnd + 1440 : rawEnd;
    await client.query(`INSERT INTO occupancy_intervals(user_id,override_date,position,starts_at,ends_at,end_as_24)
      VALUES($1,$2,$3,($2::date + $4::int * interval '1 minute') AT TIME ZONE $6,
      ($2::date + $5::int * interval '1 minute') AT TIME ZONE $6,$7)`,
      [userId, date, position, start, end, zone, slot.end === "24:00"]);
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
      ALTER TABLE users ADD COLUMN IF NOT EXISTS time_zone TEXT NOT NULL DEFAULT 'Asia/Yekaterinburg';
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
        end_as_24 BOOLEAN NOT NULL DEFAULT FALSE,
        FOREIGN KEY(user_id,override_date) REFERENCES day_overrides(user_id,override_date) ON DELETE CASCADE,
        UNIQUE(user_id,override_date,position)
      );
      CREATE INDEX IF NOT EXISTS idx_occupancy_intervals_user_start ON occupancy_intervals(user_id,starts_at);
    `);

    // If occupancy_intervals still has the legacy 'note' (slot label) column, migrate meaningful labels into day_overrides.note when empty, then drop the column
    const hasIntervalNoteCol = await client.query(
      "SELECT 1 FROM pg_attribute WHERE attrelid='occupancy_intervals'::regclass AND attname='note' AND NOT attisdropped"
    );
    if (hasIntervalNoteCol.rows.length) {
      await client.query(`
        UPDATE day_overrides d
        SET note = sub.slot_note
        FROM (
          SELECT DISTINCT ON (user_id, override_date)
            user_id, override_date, BTRIM(note) AS slot_note
          FROM occupancy_intervals
          WHERE note IS NOT NULL
            AND BTRIM(note) <> ''
            AND LOWER(BTRIM(note)) NOT IN ('работа', 'смена')
          ORDER BY user_id, override_date, position ASC
        ) sub
        WHERE d.user_id = sub.user_id
          AND d.override_date = sub.override_date
          AND (d.note IS NULL OR BTRIM(d.note) = '');
      `);
    }

    await client.query(`
      CREATE OR REPLACE VIEW manual_override_documents AS
        SELECT d.user_id,d.override_date,
          jsonb_strip_nulls(jsonb_build_object(
            'status',d.status,
            'note',d.note,
            'timeZone',CASE WHEN d.time_zone='Asia/Yekaterinburg' THEN NULL ELSE d.time_zone END,
            'slots',
            COALESCE((SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
              'start',to_char(i.starts_at AT TIME ZONE d.time_zone,'HH24:MI'),
              'end',CASE WHEN i.end_as_24 THEN '24:00' ELSE to_char(i.ends_at AT TIME ZONE d.time_zone,'HH24:MI') END)) ORDER BY i.position)
              FROM occupancy_intervals i WHERE i.user_id=d.user_id AND i.override_date=d.override_date),'[]'::jsonb))) AS value
        FROM day_overrides d;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;
      CREATE OR REPLACE VIEW user_profiles AS
        SELECT u.id,u.username,u.display_name,u.password,u.avatar_color,u.avatar_url,u.banner_url,
          u.timeline_style,u.member_orders,u.schedule_config,u.revision,u.created_at,
          COALESCE((SELECT jsonb_object_agg(to_char(d.override_date,'YYYY-MM-DD'),d.value)
            FROM manual_override_documents d WHERE d.user_id=u.id),'{}'::jsonb) AS overrides,
          u.time_zone,
          (u.is_admin OR LOWER(u.username)='qkeeper') AS is_admin,
          (LOWER(u.username)='qkeeper') AS is_super_admin
        FROM users u;
    `);

    if (hasIntervalNoteCol.rows.length) {
      await client.query("ALTER TABLE occupancy_intervals DROP COLUMN IF EXISTS note");
    }

    // Strip any legacy `label` fields from users.schedule_config JSONB
    const { rows: allUsers } = await client.query("SELECT id, schedule_config FROM users ORDER BY id");
    for (const uRow of allUsers) {
      const { cleaned, changed } = stripSlotLabelsInScheduleConfig(uRow.schedule_config);
      if (changed) {
        await client.query("UPDATE users SET schedule_config = $1 WHERE id = $2", [
          JSON.stringify(cleaned),
          uRow.id,
        ]);
      }
    }

    const legacy = await client.query("SELECT 1 FROM pg_attribute WHERE attrelid='users'::regclass AND attname='overrides' AND NOT attisdropped");
    if (legacy.rows.length) {
      const { rows } = await client.query("SELECT id,overrides FROM users ORDER BY id");
      for (const row of rows) {
        const expectedDocs: Record<string, any> = {};
        for (const [date, raw] of Object.entries<any>(row.overrides)) {
          const validDate = dateSchema.parse(date);
          let dayNote: string | undefined =
            typeof raw?.note === "string" && raw.note.trim() ? raw.note : undefined;
          if (!dayNote && Array.isArray(raw?.slots)) {
            for (const s of raw.slots) {
              if (isMeaningfulLabel(s?.label)) {
                dayNote = s.label.trim();
                break;
              }
            }
          }
          const cleanedRaw = {
            ...(raw || {}),
            ...(dayNote !== undefined ? { note: dayNote } : {}),
            slots: Array.isArray(raw?.slots)
              ? raw.slots.map((s: any) => {
                  if (s && typeof s === "object") {
                    const { label: _removed, ...rest } = s;
                    return rest;
                  }
                  return s;
                })
              : [],
          };
          if (cleanedRaw.note === undefined) delete cleanedRaw.note;
          const parsedOverride = overrideSchema.parse(cleanedRaw);
          expectedDocs[validDate] = parsedOverride;
          await replaceManualDay(client, row.id, validDate, parsedOverride);
        }
        const check = await client.query("SELECT overrides=$2::jsonb AS matches FROM user_profiles WHERE id=$1", [row.id, JSON.stringify(expectedDocs)]);
        if (!check.rows[0]?.matches) throw new Error(`Manual override migration verification failed for user ${row.id}`);
      }
      // Drop only after every document round-trips exactly; otherwise roll back.
      await client.query("ALTER TABLE users DROP COLUMN overrides");
    }
    await client.query("COMMIT");
  } catch (e) { await client.query("ROLLBACK"); throw e; }
}
