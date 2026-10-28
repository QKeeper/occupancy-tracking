import express from "express";
import { migrateManualOverrides, getScheduleTimeZone } from "./manual-overrides";
import { USER_COLUMNS } from "./user-routes";
import { createPatternMedia } from "./pattern-media";
import { initAuth, installAuth, issueSession, hashPassword, verifyPassword } from "./auth";
import { installUserRoutes } from "./user-routes";
import { installGroupRoutes, HttpError } from "./group-routes";
import { initAdmin, installAdminRoutes, isSuperAdminUsername, recordUserActivity } from "./admin-routes";
import { usernameSchema, passwordSchema, timeZoneSchema } from "./validation";
import dotenv from "dotenv";
import pg from "pg";
import { z } from "zod";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import sharp from "sharp";
import { addDays, format, parseISO } from "date-fns";
import { getOpenApiSpec, getLlmsTxtContent } from "./openapi";
import {
  getUserDaySchedule,
  computeCombinationOverlap,
  computeContinuousFreeOverlap,
} from "../src/lib/schedule-engine";

dotenv.config();

const { Pool } = pg;

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const uploadsDir = path.resolve(process.cwd(), "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const patternMedia = createPatternMedia(uploadsDir);

function saveDataUrlAsImageFile(
  value: string | null | undefined,
  kind: "avatar" | "banner" | "icon" = "avatar"
): string | null {
  if (!value) return null;
  if (!value.startsWith("data:")) return value;

  const match = value.match(/^data:([^;,]+)(;base64)?,(.*)$/s);
  if (!match) return value;

  const mime = match[1].toLowerCase();
  const isBase64 = Boolean(match[2]);
  const rawPayload = match[3];

  let ext = "png";
  if (mime.includes("gif")) ext = "gif";
  else if (mime.includes("webp")) ext = "webp";
  else if (mime.includes("jpeg") || mime.includes("jpg")) ext = "jpg";
  else if (mime.includes("svg")) ext = "svg";

  const buffer = isBase64
    ? Buffer.from(rawPayload, "base64")
    : Buffer.from(decodeURIComponent(rawPayload), "utf8");

  const hash = crypto.createHash("sha256").update(buffer).digest("hex").slice(0, 20);
  const fileName = `${kind}_${hash}.${ext}`;
  const filePath = path.join(uploadsDir, fileName);

  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, buffer);
  }

  return `/uploads/${fileName}`;
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "25mb" }));
installAuth(app, pool);
app.use(
  "/uploads",
  express.static(uploadsDir, {
    maxAge: "365d",
    immutable: true,
  })
);

export interface TimeSlot {
  start: string;
  end: string;
}

export interface ScheduleConfig {
  mode: "fixed_weekly" | "shift_cycle" | "manual";
  weekly?: {
    [dayOfWeek: string]: {
      isWorking: boolean;
      slots: TimeSlot[];
    };
  };
  shift?: {
    workDays: number;
    offDays: number;
    startDate: string;
    slots: TimeSlot[];
  };
}

async function initDb() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(64) UNIQUE NOT NULL,
        display_name VARCHAR(128) NOT NULL,
        password TEXT NOT NULL,
        avatar_color VARCHAR(32) DEFAULT '#3B82F6',
        schedule_config JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      ALTER TABLE users DROP COLUMN IF EXISTS role_title;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT DEFAULT NULL;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS banner_url TEXT DEFAULT NULL;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS timeline_style JSONB NOT NULL DEFAULT '{"bgColor":"#e11d48","patternColor":"#fda4af","patternType":"stripes","symbol":"⚡"}'::jsonb;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS member_orders JSONB NOT NULL DEFAULT '{}'::jsonb;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS time_zone TEXT NOT NULL DEFAULT 'Asia/Yekaterinburg';

      CREATE TABLE IF NOT EXISTS groups (
        id SERIAL PRIMARY KEY,
        name VARCHAR(128) NOT NULL,
        description TEXT DEFAULT '',
        owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS group_members (
        group_id INTEGER REFERENCES groups(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        status VARCHAR(32) NOT NULL DEFAULT 'accepted',
        invited_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (group_id, user_id)
      );

      CREATE INDEX IF NOT EXISTS idx_group_members_user_id ON group_members(user_id);
      CREATE INDEX IF NOT EXISTS idx_group_members_group_id ON group_members(group_id);
      CREATE INDEX IF NOT EXISTS idx_users_lower_username ON users(LOWER(username));
    `);

    await initAuth(client);
    await migrateManualOverrides(client);
    await initAdmin(client);
    await patternMedia.migrate(client);

    // Automatically migrate any legacy base64 avatar_url / banner_url stored in DB into static /uploads files
    const { rows: base64Users } = await client.query(
      "SELECT id, avatar_url, banner_url FROM users WHERE avatar_url LIKE 'data:%' OR banner_url LIKE 'data:%'"
    );
    for (const row of base64Users) {
      const migratedAvatar = saveDataUrlAsImageFile(row.avatar_url, "avatar");
      const migratedBanner = saveDataUrlAsImageFile(row.banner_url, "banner");
      await client.query(
        "UPDATE users SET avatar_url = $1, banner_url = $2 WHERE id = $3",
        [migratedAvatar, migratedBanner, row.id]
      );
      console.log(
        `[initDb] Migrated base64 media for user #${row.id} -> avatar=${migratedAvatar}, banner=${migratedBanner}`
      );
    }
  } finally {
    client.release();
  }
}

// Real-time SSE clients for instant sync across connected users
const sseClients = new Set<express.Response>();

function broadcastUpdate(eventType: string, payload?: any) {
  const msg = `data: ${JSON.stringify({ type: eventType, payload, ts: Date.now() })}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(msg);
    } catch {
      sseClients.delete(res);
    }
  }
}

installAdminRoutes(app, pool, uploadsDir, broadcastUpdate);
installUserRoutes(app, pool, broadcastUpdate, saveDataUrlAsImageFile, patternMedia.normalizeStyle);
patternMedia.install(app);
installGroupRoutes(app, pool, broadcastUpdate);

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.get("/api/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  res.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);
  sseClients.add(res);

  req.on("close", () => {
    sseClients.delete(res);
  });
});

// Lightweight batch user lookup for saved accounts (without heavy schedule_config/overrides)
app.get("/api/users-mini", async (req, res) => {
  try {
    const rawIds = String(req.query.ids || "")
      .split(",")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => !Number.isNaN(n));
    if (rawIds.length === 0) return res.json([]);
    const { rows } = await pool.query(
      "SELECT id, username, display_name, avatar_color, avatar_url FROM users WHERE id = ANY($1::int[])",
      [rawIds]
    );
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Upload base64 dataUrl (with optional normalized crop { x, y, width, height }) and return static /uploads/... file URL
app.post("/api/upload", async (req, res, next) => {
  try {
    const { dataUrl, kind, crop } = req.body;
    if (!dataUrl || typeof dataUrl !== "string") {
      return res.status(400).json({ error: "Не передан файл" });
    }
    const safeKind = kind === "banner" || kind === "icon" ? kind : "avatar";
    if (safeKind === "icon") return res.json({ url: await patternMedia.saveIcon(dataUrl) });

    if (
      crop &&
      typeof crop.x === "number" &&
      typeof crop.y === "number" &&
      typeof crop.width === "number" &&
      typeof crop.height === "number" &&
      dataUrl.startsWith("data:")
    ) {
      const match = dataUrl.match(/^data:([^;,]+)(;base64)?,(.*)$/s);
      if (match) {
        const mime = match[1].toLowerCase();
        const isBase64 = Boolean(match[2]);
        const rawPayload = match[3];
        const inputBuffer = isBase64
          ? Buffer.from(rawPayload, "base64")
          : Buffer.from(decodeURIComponent(rawPayload), "utf8");

        if (!mime.includes("svg")) {
          const img = sharp(inputBuffer, { animated: true });
          const meta = await img.metadata();
          const fw = meta.width || 100;
          const fh = meta.pageHeight || meta.height || 100;
          const pages = meta.pages || 1;

          const cx = Math.max(0, Math.min(fw - 1, Math.round(crop.x * fw)));
          const cy = Math.max(0, Math.min(fh - 1, Math.round(crop.y * fh)));
          const cw = Math.max(1, Math.min(fw - cx, Math.round(crop.width * fw)));
          const ch = Math.max(1, Math.min(fh - cy, Math.round(crop.height * fh)));

          let outBuffer: Buffer;
          let ext = "png";

          if (pages > 1) {
            ext = "gif";
            // If full frame is selected without cropping, keep original animated GIF buffer untouched
            if (cx === 0 && cy === 0 && cw === fw && ch === fh) {
              outBuffer = inputBuffer;
            } else {
              // Animated GIF / WebP: slice (cx, cy, cw, ch) from every frame and re-encode animated GIF with pageHeight = ch
              const { data } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
              const outRaw = Buffer.allocUnsafe(cw * ch * pages * 4);
              for (let p = 0; p < pages; p++) {
                const frameOffset = p * fw * fh * 4;
                const outFrameOffset = p * cw * ch * 4;
                for (let y = 0; y < ch; y++) {
                  const srcStart = frameOffset + ((cy + y) * fw + cx) * 4;
                  data.copy(outRaw, outFrameOffset + y * cw * 4, srcStart, srcStart + cw * 4);
                }
              }
              outBuffer = await sharp(outRaw, {
                raw: { width: cw, height: ch * pages, channels: 4, pageHeight: ch },
              })
                .gif({ delay: meta.delay, loop: meta.loop ?? 0 })
                .toBuffer();
            }
          } else {
            // Static image (or single-frame GIF) — banner uses unified 18:5 (3.6:1) aspect ratio
            const targetW = safeKind === "avatar" ? 256 : 864;
            const targetH = safeKind === "avatar" ? 256 : 240;
            ext = "webp";
            outBuffer = await sharp(inputBuffer)
              .extract({ left: cx, top: cy, width: cw, height: ch })
              .resize(targetW, targetH, { fit: "cover" })
              .webp({ quality: 90 })
              .toBuffer();
          }

          const hash = crypto.createHash("sha256").update(outBuffer).digest("hex").slice(0, 20);
          const fileName = `${safeKind}_${hash}.${ext}`;
          const filePath = path.join(uploadsDir, fileName);
          if (!fs.existsSync(filePath)) {
            fs.writeFileSync(filePath, outBuffer);
          }
          return res.json({ url: `/uploads/${fileName}` });
        }
      }
    }

    const url = saveDataUrlAsImageFile(dataUrl, safeKind);
    res.json({ url });
  } catch (err: any) {
    next(err);
  }
});

// Get user by id
app.get("/api/users/:id", async (req, res) => {
  try {
    const userId = parseInt(req.params.id, 10);
    const { rows } = await pool.query(
      `SELECT ${USER_COLUMNS} FROM user_profiles WHERE id = $1`,
      [userId]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Не найден" });
    res.json(rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

const serverLoginSchema = z.object({
  username: z.string().trim().min(1, "Введите @username"),
  password: z.string().min(1, "Введите пароль").max(1024),
});

const serverRegisterSchema = z.object({
  username: usernameSchema,
  display_name: z.string().trim().min(1, "Введите имя").max(64, "Имя слишком длинное"),
  password: passwordSchema,
  avatar_color: z.string().optional(),
  time_zone: timeZoneSchema.optional(),
});

const serverChangePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Укажите текущий пароль").max(1024),
  newPassword: passwordSchema,
});

// Login user by @username and password
app.post("/api/auth/login", async (req, res) => {
  try {
    const parsed = serverLoginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || "Ошибка валидации" });
    }
    const { username, password } = parsed.data;
    const cleanUsername = username.toLowerCase().replace(/^@/, "");
    const { rows } = await pool.query(
      "SELECT id, username, display_name, password, avatar_color, avatar_url, banner_url, timeline_style, member_orders, schedule_config, overrides, revision, time_zone, is_admin, is_super_admin FROM user_profiles WHERE LOWER(username) = $1",
      [cleanUsername]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: "Пользователь с таким @username не найден" });
    }
    const userRow = rows[0];
    if (!(await verifyPassword(password, userRow.password))) {
      return res.status(401).json({ error: "Неверный пароль" });
    }
    const { password: _removed, ...safeUser } = userRow;
    await issueSession(pool, req, res, userRow.id, userRow.password);
    recordUserActivity(pool, userRow.id);
    res.json(safeUser);
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.status ? err.message : "Ошибка входа" });
  }
});

// Register user with password
app.post("/api/auth/register", async (req, res) => {
  try {
    const parsed = serverRegisterSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || "Ошибка валидации" });
    }
    const { username, display_name, password, avatar_color, time_zone } = parsed.data;
    const cleanUsername = username.toLowerCase().replace(/^@/, "");
    const userTimeZone = time_zone || getScheduleTimeZone();
    const defaultSchedule: ScheduleConfig = {
      mode: "fixed_weekly",
      weekly: {
        "1": { isWorking: true, slots: [{ start: "09:00", end: "18:00" }] },
        "2": { isWorking: true, slots: [{ start: "09:00", end: "18:00" }] },
        "3": { isWorking: true, slots: [{ start: "09:00", end: "18:00" }] },
        "4": { isWorking: true, slots: [{ start: "09:00", end: "18:00" }] },
        "5": { isWorking: true, slots: [{ start: "09:00", end: "18:00" }] },
        "6": { isWorking: false, slots: [] },
        "0": { isWorking: false, slots: [] },
      },
      shift: {
        workDays: 2,
        offDays: 2,
        startDate: new Date().toISOString().slice(0, 10),
        slots: [{ start: "09:00", end: "21:00" }],
      },
    };

    const { rows } = await pool.query(
      `INSERT INTO users (username, display_name, password, avatar_color, schedule_config, time_zone, is_admin)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        cleanUsername,
        display_name.trim(),
        await hashPassword(password),
        avatar_color || "#3B82F6",
        JSON.stringify(defaultSchedule),
        userTimeZone,
        isSuperAdminUsername(cleanUsername),
      ]
    );
    await issueSession(pool, req, res, rows[0].id);
    recordUserActivity(pool, rows[0].id);
    const profile = await pool.query(`SELECT ${USER_COLUMNS} FROM user_profiles WHERE id=$1`, [rows[0].id]);
    res.json(profile.rows[0]);
    broadcastUpdate("user_registered", { id: rows[0].id });
  } catch (err: any) {
    if (err.code === "23505") {
      return res.status(400).json({ error: "Этот @username уже занят" });
    }
    res.status(500).json({ error: err.message });
  }
});

// Change user password
app.post("/api/users/:id/change-password", async (req, res) => {
  try {
    const userId = parseInt(req.params.id, 10);
    const parsed = serverChangePasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || "Ошибка валидации" });
    }
    const { currentPassword, newPassword } = parsed.data;

    const { rows } = await pool.query("SELECT password FROM users WHERE id = $1", [userId]);
    if (rows.length === 0) {
      return res.status(404).json({ error: "Пользователь не найден" });
    }
    if (!(await verifyPassword(currentPassword, rows[0].password))) {
      return res.status(400).json({ error: "Неверный текущий пароль" });
    }

    const nextHash = await hashPassword(newPassword);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const changed = await client.query("UPDATE users SET password=$1 WHERE id=$2 AND password=$3 RETURNING id", [nextHash, userId, rows[0].password]);
      if (!changed.rows.length) { await client.query("ROLLBACK"); return res.status(409).json({ error: "Пароль уже изменился" }); }
      await client.query("DELETE FROM auth_sessions WHERE user_id=$1", [userId]);
      await client.query("COMMIT");
    } catch (e) { await client.query("ROLLBACK"); throw e; }
    finally { client.release(); }
    await issueSession(pool, req, res, userId, nextHash);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Get groups for a user
app.get("/api/groups", async (req, res) => {
  try {
    const userId = res.locals.userId;
    if (req.query.userId && Number(req.query.userId) !== userId) return res.status(403).json({ error: "Нельзя читать чужой список групп" });

    const { rows: groups } = userId
      ? await pool.query(
          `SELECT g.*, u.username as owner_username, u.display_name as owner_name
           FROM groups g
           LEFT JOIN users u ON g.owner_id = u.id
           WHERE EXISTS (
             SELECT 1 FROM group_members gm2
             WHERE gm2.group_id = g.id AND gm2.user_id = $1
           )
           ORDER BY g.id ASC`,
          [userId]
        )
      : await pool.query(`
          SELECT g.*, u.username as owner_username, u.display_name as owner_name
          FROM groups g
          LEFT JOIN users u ON g.owner_id = u.id
          ORDER BY g.id ASC
        `);

    if (groups.length === 0) {
      return res.json([]);
    }

    const groupIds = groups.map((g) => g.id);
    const { rows: members } = await pool.query(
      `SELECT gm.group_id, gm.user_id, gm.status, gm.invited_by, gm.joined_at,
              u.username, u.display_name, u.avatar_color, u.avatar_url, u.banner_url,
              (u.timeline_style - 'iconHistory') AS timeline_style,
              u.schedule_config, u.overrides, u.revision, u.time_zone,
              inv.display_name as invited_by_name, inv.username as invited_by_username
       FROM group_members gm
       JOIN user_profiles u ON gm.user_id = u.id
       LEFT JOIN users inv ON gm.invited_by = inv.id
       WHERE gm.group_id = ANY($1::int[])
       ORDER BY gm.joined_at ASC`,
      [groupIds]
    );

    const result = groups.map((g) => {
      const gMembers = members.filter((m) => m.group_id === g.id);
      const myMembership = userId ? gMembers.find((m) => m.user_id === userId) : null;
      return {
        ...g,
        my_status: myMembership ? myMembership.status : null,
        invited_by_name: myMembership?.invited_by_name || null,
        invited_by_username: myMembership?.invited_by_username || null,
        members: gMembers,
      };
    });

    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// AGENT & OPENAPI ENDPOINTS
// ============================================================================

// OpenAPI 3.1.0 specification
app.get(["/api/openapi.json", "/openapi.json"], (req, res) => {
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost:5173";
  res.json(getOpenApiSpec(`${proto}://${host}`));
});

// LLM / Agent markdown guide (llms.txt standard)
app.get(["/api/llms.txt", "/llms.txt"], (req, res) => {
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost:5173";
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.send(getLlmsTxtContent(`${proto}://${host}`));
});

// List all users or filter by @username
app.get("/api/users", async (req, res) => {
  try {
    const rawUname = req.query.username ? String(req.query.username).trim().toLowerCase().replace(/^@/, "") : "";
    if (rawUname) {
      const { rows } = await pool.query(
        "SELECT id, username, display_name, avatar_color, avatar_url, schedule_config, overrides, revision, created_at, time_zone FROM user_profiles WHERE LOWER(username) LIKE $1 ORDER BY id ASC",
        [`%${rawUname}%`]
      );
      return res.json(rows);
    }
    const { rows } = await pool.query(
      "SELECT id, username, display_name, avatar_color, avatar_url, schedule_config, overrides, revision, created_at, time_zone FROM user_profiles ORDER BY id ASC"
    );
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Compute group availability & common free windows across a date range
app.get("/api/groups/:groupId/availability", async (req, res) => {
  try {
    const groupId = parseInt(req.params.groupId, 10);
    const grpRes = await pool.query("SELECT * FROM groups WHERE id = $1", [groupId]);
    if (grpRes.rows.length === 0) {
      return res.status(404).json({ error: "Группа не найдена" });
    }
    const group = grpRes.rows[0];
    const membership = await pool.query("SELECT 1 FROM group_members WHERE group_id=$1 AND user_id=$2 AND status='accepted'", [groupId, res.locals.userId]);
    if (!membership.rows.length) return res.status(403).json({ error: "Нет доступа к группе" });

    const { rows: memberRows } = await pool.query(
      `SELECT u.id, u.username, u.display_name, u.avatar_color, u.avatar_url,
              u.schedule_config, u.overrides, u.time_zone
       FROM group_members gm
       JOIN user_profiles u ON gm.user_id = u.id
       WHERE gm.group_id = $1 AND gm.status = 'accepted'
       ORDER BY gm.joined_at ASC`,
      [groupId]
    );

    const requesterRow = memberRows.find((m) => m.id === res.locals.userId);
    const requestedTz = req.query.timeZone ? String(req.query.timeZone).trim() : "";
    const viewerTimeZone = requestedTz
      ? timeZoneSchema.parse(requestedTz)
      : requesterRow?.time_zone || getScheduleTimeZone();

    const rawStartDate = req.query.startDate ? String(req.query.startDate).trim() : format(new Date(), "yyyy-MM-dd");
    const parsedStart = parseISO(rawStartDate);
    const startDate = Number.isNaN(parsedStart.getTime()) ? new Date() : parsedStart;

    const daysCount = Math.max(
      1,
      Math.min(31, req.query.days ? parseInt(String(req.query.days), 10) || 7 : 7)
    );
    const windowStart = req.query.windowStart ? String(req.query.windowStart) : "09:00";
    const windowEnd = req.query.windowEnd ? String(req.query.windowEnd) : "23:00";
    const minCommonHours = req.query.minCommonHours
      ? Math.max(0.5, Number(req.query.minCommonHours) || 2)
      : 2;

    const filterIds = req.query.memberIds
      ? String(req.query.memberIds)
          .split(",")
          .map((s) => parseInt(s.trim(), 10))
          .filter((n) => !Number.isNaN(n))
      : [];

    const activeMembers =
      filterIds.length > 0
        ? memberRows.filter((m) => filterIds.includes(m.id))
        : memberRows;

    const days = Array.from({ length: daysCount }, (_, idx) => addDays(startDate, idx));

    const membersWithSchedules = activeMembers.map((m) => ({
      id: m.id,
      username: m.username,
      display_name: m.display_name,
      time_zone: m.time_zone,
      schedule_mode: m.schedule_config?.mode || "fixed_weekly",
      dailySchedule: days.map((d) => getUserDaySchedule(m as any, d, viewerTimeZone)),
    }));

    const dailyOverlap = days.map((d) =>
      computeCombinationOverlap(activeMembers as any, d, windowStart, windowEnd, minCommonHours, viewerTimeZone)
    );

    const continuousFreeWindows = computeContinuousFreeOverlap(
      activeMembers as any,
      days,
      Math.round(minCommonHours * 60),
      viewerTimeZone
    );

    res.json({
      group: {
        id: group.id,
        name: group.name,
        description: group.description,
        owner_id: group.owner_id,
      },
      query: {
        startDate: format(startDate, "yyyy-MM-dd"),
        days: daysCount,
        windowStart,
        windowEnd,
        minCommonHours,
        timeZone: viewerTimeZone,
        selectedMemberIds: activeMembers.map((m) => m.id),
      },
      members: membersWithSchedules,
      dailyOverlap,
      continuousFreeWindows,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// In production, serve the built SPA from /dist if it exists
const distDir = path.resolve(process.cwd(), "dist");
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get("*", (req, res, next) => {
    if (
      req.path.startsWith("/api") ||
      req.path.startsWith("/uploads") ||
      req.path === "/openapi.json" ||
      req.path === "/llms.txt"
    ) {
      return next();
    }
    res.sendFile(path.join(distDir, "index.html"));
  });
}

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof z.ZodError) return res.status(400).json({ error: err.issues[0]?.message || "Некорректные данные", issues: err.issues });
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err.code === "23505") return res.status(409).json({ error: "Такое значение уже существует" });
  if (err.type === "entity.parse.failed") return res.status(400).json({ error: "Некорректный JSON" });
  console.error("Request failed", err.code || err.name);
  res.status(500).json({ error: "Ошибка сервера" });
});
const PORT = process.env.PORT || 3001;

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Syncro API Server running on http://127.0.0.1:${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Failed to initialize database:", err);
  });
