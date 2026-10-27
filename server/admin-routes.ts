import express from "express";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { Express, Request, Response, NextFunction } from "express";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { HttpError } from "./group-routes";

export const SUPER_ADMIN_USERNAME = "qkeeper";

export function isSuperAdminUsername(username?: string | null): boolean {
  return String(username || "").trim().toLowerCase().replace(/^@/, "") === SUPER_ADMIN_USERNAME;
}

export async function initAdmin(client: PoolClient) {
  await client.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;
    UPDATE users SET is_admin = TRUE WHERE LOWER(username) = '${SUPER_ADMIN_USERNAME}' AND is_admin = FALSE;

    CREATE TABLE IF NOT EXISTS user_daily_activity (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      activity_date DATE NOT NULL DEFAULT CURRENT_DATE,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      requests_count INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (user_id, activity_date)
    );
    CREATE INDEX IF NOT EXISTS idx_user_daily_activity_date ON user_daily_activity(activity_date);
    CREATE INDEX IF NOT EXISTS idx_user_daily_activity_last_seen ON user_daily_activity(last_seen_at);
  `);

  // Recreate user_profiles view to include is_admin and is_super_admin
  await client.query(`
    CREATE OR REPLACE VIEW user_profiles AS
      SELECT u.id, u.username, u.display_name, u.password, u.avatar_color, u.avatar_url, u.banner_url,
        u.timeline_style, u.member_orders, u.schedule_config, u.revision, u.created_at,
        COALESCE((SELECT jsonb_object_agg(to_char(d.override_date,'YYYY-MM-DD'),d.value)
          FROM manual_override_documents d WHERE d.user_id=u.id),'{}'::jsonb) AS overrides,
        u.time_zone,
        (u.is_admin OR LOWER(u.username) = '${SUPER_ADMIN_USERNAME}') AS is_admin,
        (LOWER(u.username) = '${SUPER_ADMIN_USERNAME}') AS is_super_admin
      FROM users u;
  `);

  // Seed initial activity from existing users & overrides if table is empty so charts have historical context
  const existingCount = await client.query("SELECT COUNT(*)::int AS cnt FROM user_daily_activity");
  if (existingCount.rows[0]?.cnt === 0) {
    await client.query(`
      INSERT INTO user_daily_activity (user_id, activity_date, first_seen_at, last_seen_at, requests_count)
      SELECT id, (created_at AT TIME ZONE 'UTC')::date, created_at, created_at, 1
      FROM users
      WHERE created_at IS NOT NULL
      ON CONFLICT (user_id, activity_date) DO NOTHING;
    `);
  }
}

// Throttle in-memory activity writes per user to at most once every 30 seconds
const lastActivityWrite = new Map<number, { dateStr: string; ts: number }>();

export function recordUserActivity(pool: Pool, userId: number) {
  if (!userId || !Number.isSafeInteger(userId)) return;
  const now = Date.now();
  const dateStr = new Date(now).toISOString().slice(0, 10);
  const prev = lastActivityWrite.get(userId);
  if (prev && prev.dateStr === dateStr && now - prev.ts < 30_000) {
    return;
  }
  lastActivityWrite.set(userId, { dateStr, ts: now });

  pool
    .query(
      `INSERT INTO user_daily_activity (user_id, activity_date, first_seen_at, last_seen_at, requests_count)
       VALUES ($1, $2::date, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1)
       ON CONFLICT (user_id, activity_date) DO UPDATE
       SET last_seen_at = CURRENT_TIMESTAMP,
           requests_count = user_daily_activity.requests_count + 1`,
      [userId, dateStr]
    )
    .catch(() => {
      // Ignore background telemetry errors
    });
}

export interface UploadsMediaScanResult {
  totalFiles: number;
  totalBytes: number;
  referencedFilesCount: number;
  referencedBytes: number;
  orphanedFilesCount: number;
  orphanedBytes: number;
  byKind: {
    avatar: { count: number; bytes: number };
    banner: { count: number; bytes: number };
    icon: { count: number; bytes: number };
    other: { count: number; bytes: number };
  };
  byExtension: Record<string, { count: number; bytes: number }>;
  orphanedFiles: {
    name: string;
    url: string;
    kind: "avatar" | "banner" | "icon" | "other";
    ext: string;
    sizeBytes: number;
    mtime: string;
  }[];
  largestFiles: {
    name: string;
    url: string;
    kind: "avatar" | "banner" | "icon" | "other";
    ext: string;
    sizeBytes: number;
    isReferenced: boolean;
    mtime: string;
  }[];
}

export async function scanUploadsDirectory(pool: Pool, uploadsDir: string): Promise<UploadsMediaScanResult> {
  // 1. Collect all referenced /uploads/... paths from users
  const { rows: users } = await pool.query(
    "SELECT avatar_url, banner_url, timeline_style FROM users"
  );

  const referencedNames = new Set<string>();
  const addRef = (val: unknown) => {
    if (typeof val === "string" && val.startsWith("/uploads/")) {
      const base = path.basename(val);
      if (base && base !== ".gitkeep") referencedNames.add(base);
    }
  };

  for (const u of users) {
    addRef(u.avatar_url);
    addRef(u.banner_url);
    const style = u.timeline_style;
    if (style && typeof style === "object") {
      addRef(style.symbol);
      if (Array.isArray(style.iconHistory)) {
        for (const item of style.iconHistory) addRef(item);
      }
    }
  }

  // 2. Scan files in uploadsDir
  let entries: fs.Dirent[] = [];
  try {
    entries = await fsp.readdir(uploadsDir, { withFileTypes: true });
  } catch {
    entries = [];
  }

  let totalFiles = 0;
  let totalBytes = 0;
  let referencedFilesCount = 0;
  let referencedBytes = 0;
  let orphanedFilesCount = 0;
  let orphanedBytes = 0;

  const byKind = {
    avatar: { count: 0, bytes: 0 },
    banner: { count: 0, bytes: 0 },
    icon: { count: 0, bytes: 0 },
    other: { count: 0, bytes: 0 },
  };
  const byExtension: Record<string, { count: number; bytes: number }> = {};
  const allFileRecords: UploadsMediaScanResult["largestFiles"] = [];
  const orphanedFiles: UploadsMediaScanResult["orphanedFiles"] = [];

  for (const entry of entries) {
    if (!entry.isFile() || entry.name === ".gitkeep" || entry.name.startsWith(".")) continue;
    const fullPath = path.join(uploadsDir, entry.name);
    let stat: fs.Stats;
    try {
      stat = await fsp.stat(fullPath);
    } catch {
      continue;
    }

    const sizeBytes = stat.size;
    const ext = path.extname(entry.name).replace(/^\./, "").toLowerCase() || "unknown";
    let kind: "avatar" | "banner" | "icon" | "other" = "other";
    if (entry.name.startsWith("avatar_")) kind = "avatar";
    else if (entry.name.startsWith("banner_")) kind = "banner";
    else if (entry.name.startsWith("icon_")) kind = "icon";

    const isReferenced = referencedNames.has(entry.name);

    totalFiles++;
    totalBytes += sizeBytes;
    byKind[kind].count++;
    byKind[kind].bytes += sizeBytes;

    if (!byExtension[ext]) byExtension[ext] = { count: 0, bytes: 0 };
    byExtension[ext].count++;
    byExtension[ext].bytes += sizeBytes;

    const record = {
      name: entry.name,
      url: `/uploads/${entry.name}`,
      kind,
      ext,
      sizeBytes,
      isReferenced,
      mtime: stat.mtime.toISOString(),
    };
    allFileRecords.push(record);

    if (isReferenced) {
      referencedFilesCount++;
      referencedBytes += sizeBytes;
    } else {
      orphanedFilesCount++;
      orphanedBytes += sizeBytes;
      orphanedFiles.push({
        name: entry.name,
        url: `/uploads/${entry.name}`,
        kind,
        ext,
        sizeBytes,
        mtime: stat.mtime.toISOString(),
      });
    }
  }

  allFileRecords.sort((a, b) => b.sizeBytes - a.sizeBytes);
  orphanedFiles.sort((a, b) => b.sizeBytes - a.sizeBytes);

  return {
    totalFiles,
    totalBytes,
    referencedFilesCount,
    referencedBytes,
    orphanedFilesCount,
    orphanedBytes,
    byKind,
    byExtension,
    orphanedFiles,
    largestFiles: allFileRecords.slice(0, 15),
  };
}

export function installAdminRoutes(
  app: Express,
  pool: Pool,
  uploadsDir: string,
  broadcast: (type: string, payload?: any) => void
) {
  // Middleware to record activity for authenticated API calls
  app.use("/api", (_req: Request, res: Response, next: NextFunction) => {
    if (res.locals.userId) {
      recordUserActivity(pool, res.locals.userId);
    }
    next();
  });

  async function requireAdmin(req: Request, res: Response): Promise<{ id: number; username: string; is_admin: boolean; is_super_admin: boolean }> {
    const userId = res.locals.userId;
    if (!userId) throw new HttpError(401, "Войдите в аккаунт");
    const { rows } = await pool.query(
      "SELECT id, username, is_admin FROM users WHERE id = $1",
      [userId]
    );
    if (!rows.length) throw new HttpError(401, "Пользователь не найден");
    const row = rows[0];
    const isSuper = isSuperAdminUsername(row.username);
    const isAdmin = Boolean(row.is_admin || isSuper);
    if (!isAdmin) {
      throw new HttpError(403, "Доступ разрешён только администраторам");
    }
    return { id: row.id, username: row.username, is_admin: isAdmin, is_super_admin: isSuper };
  }

  async function requireSuperAdmin(req: Request, res: Response) {
    const actor = await requireAdmin(req, res);
    if (!actor.is_super_admin) {
      throw new HttpError(403, "Только главный администратор (@qkeeper) может управлять правами админов");
    }
    return actor;
  }

  // Main admin dashboard statistics endpoint
  app.get("/api/admin/stats", async (req, res, next) => {
    try {
      const actor = await requireAdmin(req, res);
      const daysParam = Math.max(7, Math.min(90, parseInt(String(req.query.days || "30"), 10) || 30));

      // 1. DAU & Daily Registrations & Daily Overrides series
      const { rows: dailySeries } = await pool.query(
        `WITH dates AS (
           SELECT generate_series(
             CURRENT_DATE - ($1::int - 1) * INTERVAL '1 day',
             CURRENT_DATE,
             INTERVAL '1 day'
           )::date AS d
         ),
         dau AS (
           SELECT activity_date AS d,
                  COUNT(DISTINCT user_id)::int AS active_users,
                  COALESCE(SUM(requests_count), 0)::int AS total_requests
           FROM user_daily_activity
           WHERE activity_date >= CURRENT_DATE - ($1::int - 1) * INTERVAL '1 day'
           GROUP BY activity_date
         ),
         regs AS (
           SELECT (created_at AT TIME ZONE 'UTC')::date AS d,
                  COUNT(*)::int AS new_users
           FROM users
           WHERE created_at >= CURRENT_DATE - ($1::int - 1) * INTERVAL '1 day'
           GROUP BY 1
         ),
         grps AS (
           SELECT (created_at AT TIME ZONE 'UTC')::date AS d,
                  COUNT(*)::int AS new_groups
           FROM groups
           WHERE created_at >= CURRENT_DATE - ($1::int - 1) * INTERVAL '1 day'
           GROUP BY 1
         )
         SELECT to_char(dates.d, 'YYYY-MM-DD') AS date,
                COALESCE(dau.active_users, 0)::int AS dau,
                COALESCE(dau.total_requests, 0)::int AS requests,
                COALESCE(regs.new_users, 0)::int AS new_users,
                COALESCE(grps.new_groups, 0)::int AS new_groups
         FROM dates
         LEFT JOIN dau ON dau.d = dates.d
         LEFT JOIN regs ON regs.d = dates.d
         LEFT JOIN grps ON grps.d = dates.d
         ORDER BY dates.d ASC`,
        [daysParam]
      );

      // 2. High-level KPIs & Trends (current 7d vs previous 7d, 30d MAU, WAU, DAU today)
      const { rows: kpiRows } = await pool.query(`
        SELECT
          (SELECT COUNT(*)::int FROM users) AS total_users,
          (SELECT COUNT(*)::int FROM groups) AS total_groups,
          (SELECT COUNT(*)::int FROM day_overrides) AS total_overrides,
          (SELECT COUNT(*)::int FROM occupancy_intervals) AS total_intervals,
          (SELECT COUNT(*)::int FROM auth_sessions WHERE expires_at > CURRENT_TIMESTAMP) AS active_sessions,
          (SELECT COUNT(DISTINCT user_id)::int FROM user_daily_activity WHERE activity_date = CURRENT_DATE) AS dau_today,
          (SELECT COUNT(DISTINCT user_id)::int FROM user_daily_activity WHERE activity_date = CURRENT_DATE - INTERVAL '1 day') AS dau_yesterday,
          (SELECT COUNT(DISTINCT user_id)::int FROM user_daily_activity WHERE activity_date >= CURRENT_DATE - INTERVAL '6 days') AS wau_current,
          (SELECT COUNT(DISTINCT user_id)::int FROM user_daily_activity WHERE activity_date >= CURRENT_DATE - INTERVAL '13 days' AND activity_date < CURRENT_DATE - INTERVAL '6 days') AS wau_prev,
          (SELECT COUNT(DISTINCT user_id)::int FROM user_daily_activity WHERE activity_date >= CURRENT_DATE - INTERVAL '29 days') AS mau_current,
          (SELECT COUNT(*)::int FROM users WHERE created_at >= CURRENT_TIMESTAMP - INTERVAL '7 days') AS new_users_7d,
          (SELECT COUNT(*)::int FROM users WHERE created_at >= CURRENT_TIMESTAMP - INTERVAL '14 days' AND created_at < CURRENT_TIMESTAMP - INTERVAL '7 days') AS new_users_prev_7d
      `);
      const kpi = kpiRows[0];

      // 3. Schedule mode distribution
      const { rows: modeRows } = await pool.query(`
        SELECT COALESCE(schedule_config->>'mode', 'fixed_weekly') AS mode,
               COUNT(*)::int AS count
        FROM users
        GROUP BY 1
      `);

      // 4. Database size & per-table breakdown (in current schema)
      const { rows: dbSizeRows } = await pool.query(`
        SELECT pg_database_size(current_database())::bigint AS total_db_bytes,
               current_database() AS db_name,
               current_schema() AS schema_name
      `);
      const totalDbBytes = Number(dbSizeRows[0]?.total_db_bytes || 0);

      const { rows: tableRows } = await pool.query(`
        SELECT
          c.relname AS table_name,
          pg_total_relation_size(c.oid)::bigint AS total_bytes,
          pg_relation_size(c.oid)::bigint AS data_bytes,
          (pg_total_relation_size(c.oid) - pg_relation_size(c.oid))::bigint AS index_toast_bytes,
          COALESCE(s.n_live_tup, 0)::bigint AS row_estimate
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
        WHERE n.nspname = current_schema()
          AND c.relkind = 'r'
        ORDER BY pg_total_relation_size(c.oid) DESC
      `);

      const tables = tableRows.map((r) => ({
        tableName: r.table_name,
        totalBytes: Number(r.total_bytes || 0),
        dataBytes: Number(r.data_bytes || 0),
        indexToastBytes: Number(r.index_toast_bytes || 0),
        rowEstimate: Number(r.row_estimate || 0),
      }));
      const schemaTablesBytes = tables.reduce((acc, t) => acc + t.totalBytes, 0);

      // 5. Scan uploads directory
      const mediaStats = await scanUploadsDirectory(pool, uploadsDir);

      // 6. All users with activity & admin status
      const { rows: userListRows } = await pool.query(`
        SELECT
          u.id,
          u.username,
          u.display_name,
          u.avatar_color,
          u.avatar_url,
          u.banner_url,
          u.time_zone,
          COALESCE(u.schedule_config->>'mode', 'fixed_weekly') AS schedule_mode,
          u.created_at,
          (u.is_admin OR LOWER(u.username) = $1) AS is_admin,
          (LOWER(u.username) = $1) AS is_super_admin,
          (SELECT COUNT(*)::int FROM group_members gm WHERE gm.user_id = u.id AND gm.status = 'accepted') AS groups_count,
          (SELECT COUNT(*)::int FROM day_overrides d WHERE d.user_id = u.id) AS overrides_count,
          (SELECT MAX(last_seen_at) FROM user_daily_activity uda WHERE uda.user_id = u.id) AS last_seen_at,
          (SELECT COALESCE(SUM(requests_count), 0)::int FROM user_daily_activity uda WHERE uda.user_id = u.id) AS total_requests,
          (SELECT COUNT(*)::int FROM user_daily_activity uda WHERE uda.user_id = u.id) AS active_days_count
        FROM users u
        ORDER BY
          (LOWER(u.username) = $1) DESC,
          u.is_admin DESC,
          u.id ASC
      `, [SUPER_ADMIN_USERNAME]);

      // 7. All groups summary
      const { rows: groupListRows } = await pool.query(`
        SELECT
          g.id,
          g.name,
          g.description,
          g.owner_id,
          g.created_at,
          u.username AS owner_username,
          u.display_name AS owner_display_name,
          (SELECT COUNT(*)::int FROM group_members gm WHERE gm.group_id = g.id AND gm.status = 'accepted') AS accepted_members_count,
          (SELECT COUNT(*)::int FROM group_members gm WHERE gm.group_id = g.id AND gm.status = 'pending') AS pending_members_count
        FROM groups g
        LEFT JOIN users u ON u.id = g.owner_id
        ORDER BY g.id ASC
      `);

      res.json({
        viewer: actor,
        superAdminUsername: SUPER_ADMIN_USERNAME,
        generatedAt: new Date().toISOString(),
        periodDays: daysParam,
        kpis: {
          totalUsers: kpi.total_users,
          totalGroups: kpi.total_groups,
          totalOverrides: kpi.total_overrides,
          totalIntervals: kpi.total_intervals,
          activeSessions: kpi.active_sessions,
          dauToday: kpi.dau_today,
          dauYesterday: kpi.dau_yesterday,
          wauCurrent: kpi.wau_current,
          wauPrev: kpi.wau_prev,
          mauCurrent: kpi.mau_current,
          newUsers7d: kpi.new_users_7d,
          newUsersPrev7d: kpi.new_users_prev_7d,
        },
        scheduleModes: modeRows,
        dailySeries,
        database: {
          dbName: dbSizeRows[0]?.db_name || "postgres",
          schemaName: dbSizeRows[0]?.schema_name || "public",
          totalDbBytes,
          schemaTablesBytes,
          tables,
        },
        media: mediaStats,
        users: userListRows,
        groups: groupListRows,
      });
    } catch (e) {
      next(e);
    }
  });

  // Grant or revoke admin role (ONLY @qkeeper is allowed)
  const updateAdminRoleSchema = z
    .object({
      userId: z.number().int().positive().optional(),
      username: z.string().trim().min(1).max(64).optional(),
      isAdmin: z.boolean(),
    })
    .strict();

  app.post("/api/admin/admins", async (req, res, next) => {
    try {
      await requireSuperAdmin(req, res);
      const parsed = updateAdminRoleSchema.parse(req.body);
      if (!parsed.userId && !parsed.username) {
        throw new HttpError(400, "Укажите userId или @username пользователя");
      }

      const targetRes = parsed.userId
        ? await pool.query("SELECT id, username, display_name, is_admin FROM users WHERE id = $1", [parsed.userId])
        : await pool.query("SELECT id, username, display_name, is_admin FROM users WHERE LOWER(username) = $1", [
            parsed.username!.toLowerCase().replace(/^@/, ""),
          ]);

      if (!targetRes.rows.length) {
        throw new HttpError(404, "Пользователь не найден");
      }
      const target = targetRes.rows[0];

      if (isSuperAdminUsername(target.username) && !parsed.isAdmin) {
        throw new HttpError(400, "Нельзя снять права главного администратора с @qkeeper");
      }

      const nextIsAdmin = isSuperAdminUsername(target.username) ? true : parsed.isAdmin;
      await pool.query("UPDATE users SET is_admin = $1, revision = revision + 1 WHERE id = $2", [
        nextIsAdmin,
        target.id,
      ]);

      broadcast("admin_updated", { userId: target.id, isAdmin: nextIsAdmin });
      res.json({
        ok: true,
        user: {
          id: target.id,
          username: target.username,
          display_name: target.display_name,
          is_admin: nextIsAdmin,
          is_super_admin: isSuperAdminUsername(target.username),
        },
      });
    } catch (e) {
      next(e);
    }
  });

  // Cleanup orphaned media files in /uploads
  const cleanupSchema = z
    .object({
      filenames: z.array(z.string().min(1).max(255)).max(1000).optional(),
    })
    .strict();

  app.post("/api/admin/media/cleanup", async (req, res, next) => {
    try {
      await requireAdmin(req, res);
      const body = cleanupSchema.parse(req.body || {});
      const scan = await scanUploadsDirectory(pool, uploadsDir);
      const orphanSet = new Set(scan.orphanedFiles.map((f) => f.name));

      const toDelete = body.filenames
        ? body.filenames.filter((name) => orphanSet.has(path.basename(name)))
        : scan.orphanedFiles.map((f) => f.name);

      let deletedCount = 0;
      let freedBytes = 0;

      for (const fileName of toDelete) {
        const safeName = path.basename(fileName);
        if (!orphanSet.has(safeName)) continue;
        const fullPath = path.join(uploadsDir, safeName);
        try {
          const st = await fsp.stat(fullPath);
          await fsp.unlink(fullPath);
          deletedCount++;
          freedBytes += st.size;
        } catch {
          // ignore if already removed
        }
      }

      const updatedMedia = await scanUploadsDirectory(pool, uploadsDir);
      res.json({
        ok: true,
        deletedCount,
        freedBytes,
        media: updatedMedia,
      });
    } catch (e) {
      next(e);
    }
  });
}
