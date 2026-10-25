import express from "express";
import cors from "cors";
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

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    "postgresql://postgres:Nsconsol-22910%40@127.0.0.1:5432/occupancy_tracking",
});

const uploadsDir = path.resolve(process.cwd(), "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

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
app.use(cors());
app.use(express.json({ limit: "25mb" }));
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
  label?: string;
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
        password VARCHAR(128) NOT NULL DEFAULT 'admin',
        role_title VARCHAR(128) DEFAULT 'Участник',
        avatar_color VARCHAR(32) DEFAULT '#3B82F6',
        schedule_config JSONB NOT NULL DEFAULT '{}'::jsonb,
        overrides JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      ALTER TABLE users ALTER COLUMN password SET DEFAULT 'admin';
      UPDATE users SET password = 'admin' WHERE password = '123456' OR password IS NULL OR password = '';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT DEFAULT NULL;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS banner_url TEXT DEFAULT NULL;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS timeline_style JSONB NOT NULL DEFAULT '{"bgColor":"#e11d48","patternColor":"#fda4af","patternType":"stripes","symbol":"⚡"}'::jsonb;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS member_orders JSONB NOT NULL DEFAULT '{}'::jsonb;

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
app.post("/api/upload", async (req, res) => {
  try {
    const { dataUrl, kind, crop } = req.body;
    if (!dataUrl || typeof dataUrl !== "string") {
      return res.status(400).json({ error: "Не передан файл" });
    }
    const safeKind = kind === "banner" || kind === "icon" ? kind : "avatar";

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
            // Static image (or single-frame GIF)
            const targetW = safeKind === "avatar" ? 256 : 880;
            const targetH = safeKind === "avatar" ? 256 : 200;
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
    res.status(500).json({ error: err.message });
  }
});

// Get user by id
app.get("/api/users/:id", async (req, res) => {
  try {
    const userId = parseInt(req.params.id, 10);
    const { rows } = await pool.query(
      "SELECT id, username, display_name, role_title, avatar_color, avatar_url, banner_url, timeline_style, member_orders, schedule_config, overrides, created_at FROM users WHERE id = $1",
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
  password: z.string().min(1, "Введите пароль"),
});

const serverRegisterSchema = z.object({
  username: z
    .string()
    .trim()
    .min(2, "Юзернейм должен содержать минимум 2 символа")
    .max(32, "Юзернейм слишком длинный"),
  display_name: z.string().trim().min(1, "Введите имя").max(64, "Имя слишком длинное"),
  password: z.string().min(4, "Пароль должен содержать минимум 4 символа"),
  role_title: z.string().optional(),
  avatar_color: z.string().optional(),
});

const serverChangePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Укажите текущий пароль"),
  newPassword: z.string().min(4, "Новый пароль должен содержать минимум 4 символа"),
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
      "SELECT id, username, display_name, password, role_title, avatar_color, avatar_url, banner_url, timeline_style, member_orders, schedule_config, overrides FROM users WHERE LOWER(username) = $1",
      [cleanUsername]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: "Пользователь с таким @username не найден" });
    }
    const userRow = rows[0];
    if (userRow.password !== password) {
      return res.status(401).json({ error: "Неверный пароль" });
    }
    const { password: _removed, ...safeUser } = userRow;
    res.json(safeUser);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Register user with password
app.post("/api/auth/register", async (req, res) => {
  try {
    const parsed = serverRegisterSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || "Ошибка валидации" });
    }
    const { username, display_name, password, role_title, avatar_color } = parsed.data;
    const cleanUsername = username.toLowerCase().replace(/^@/, "");
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
      `INSERT INTO users (username, display_name, password, role_title, avatar_color, schedule_config, overrides)
       VALUES ($1, $2, $3, $4, $5, $6, '{}'::jsonb)
       RETURNING id, username, display_name, role_title, avatar_color, avatar_url, banner_url, timeline_style, member_orders, schedule_config, overrides`,
      [
        cleanUsername,
        display_name.trim(),
        password,
        role_title || "Участник",
        avatar_color || "#3B82F6",
        JSON.stringify(defaultSchedule),
      ]
    );
    res.json(rows[0]);
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
    if (rows[0].password !== currentPassword) {
      return res.status(400).json({ error: "Неверный текущий пароль" });
    }

    await pool.query("UPDATE users SET password = $1 WHERE id = $2", [newPassword, userId]);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Save personal member sort order for a group
app.put("/api/users/:id/member-order", async (req, res) => {
  try {
    const userId = parseInt(req.params.id, 10);
    const { groupKey, memberIds } = req.body;
    if (!groupKey || !Array.isArray(memberIds)) {
      return res.status(400).json({ error: "Некорректные данные сортировки" });
    }
    const cleanIds = memberIds.map((id) => Number(id)).filter((id) => !Number.isNaN(id));
    const currentRes = await pool.query("SELECT member_orders FROM users WHERE id = $1", [userId]);
    if (currentRes.rows.length === 0) {
      return res.status(404).json({ error: "Пользователь не найден" });
    }
    const nextOrders = {
      ...(currentRes.rows[0].member_orders || {}),
      [String(groupKey)]: cleanIds,
    };
    await pool.query("UPDATE users SET member_orders = $1 WHERE id = $2", [
      JSON.stringify(nextOrders),
      userId,
    ]);
    res.json({ ok: true, member_orders: nextOrders });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Update user profile, username, avatar_url, banner_url, timeline_style, schedule_config & overrides
app.put("/api/users/:id", async (req, res) => {
  try {
    const userId = parseInt(req.params.id, 10);
    const {
      username,
      display_name,
      role_title,
      avatar_color,
      avatar_url,
      banner_url,
      timeline_style,
      member_orders,
      schedule_config,
      overrides,
    } = req.body;

    const currentRes = await pool.query("SELECT * FROM users WHERE id = $1", [userId]);
    if (currentRes.rows.length === 0) {
      return res.status(404).json({ error: "Пользователь не найден" });
    }
    const cur = currentRes.rows[0];
    const nextUsername = username
      ? String(username).trim().toLowerCase().replace(/^@/, "")
      : cur.username;
    const rawAvatarUrl = avatar_url !== undefined ? avatar_url : cur.avatar_url;
    const rawBannerUrl = banner_url !== undefined ? banner_url : cur.banner_url;
    const nextAvatarUrl = saveDataUrlAsImageFile(rawAvatarUrl, "avatar");
    const nextBannerUrl = saveDataUrlAsImageFile(rawBannerUrl, "banner");

    const updated = await pool.query(
      `UPDATE users
       SET username = $1,
           display_name = $2,
           role_title = $3,
           avatar_color = $4,
           avatar_url = $5,
           banner_url = $6,
           timeline_style = $7,
           member_orders = $8,
           schedule_config = $9,
           overrides = $10
       WHERE id = $11
       RETURNING id, username, display_name, role_title, avatar_color, avatar_url, banner_url, timeline_style, member_orders, schedule_config, overrides`,
      [
        nextUsername,
        display_name ?? cur.display_name,
        role_title ?? cur.role_title,
        avatar_color ?? cur.avatar_color,
        nextAvatarUrl,
        nextBannerUrl,
        JSON.stringify(timeline_style ?? cur.timeline_style ?? {}),
        JSON.stringify(member_orders ?? cur.member_orders ?? {}),
        JSON.stringify(schedule_config ?? cur.schedule_config),
        JSON.stringify(overrides ?? cur.overrides),
        userId,
      ]
    );

    res.json(updated.rows[0]);
    broadcastUpdate("schedule_updated", { userId });
  } catch (err: any) {
    if (err.code === "23505") {
      return res.status(400).json({ error: "Этот @username уже занят" });
    }
    res.status(500).json({ error: err.message });
  }
});

// Get groups for a user
app.get("/api/groups", async (req, res) => {
  try {
    const userId = req.query.userId ? parseInt(String(req.query.userId), 10) : null;

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
              u.username, u.display_name, u.role_title, u.avatar_color, u.avatar_url, u.banner_url,
              (u.timeline_style - 'iconHistory') AS timeline_style,
              u.schedule_config, u.overrides,
              inv.display_name as invited_by_name, inv.username as invited_by_username
       FROM group_members gm
       JOIN users u ON gm.user_id = u.id
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

// Create a new group
app.post("/api/groups", async (req, res) => {
  const client = await pool.connect();
  try {
    const { name, description, owner_id, invite_usernames } = req.body;
    if (!name || !owner_id) {
      return res.status(400).json({ error: "Укажите название группы" });
    }
    await client.query("BEGIN");
    const grpRes = await client.query(
      `INSERT INTO groups (name, description, owner_id) VALUES ($1, $2, $3) RETURNING *`,
      [name.trim(), (description || "").trim(), owner_id]
    );
    const group = grpRes.rows[0];

    await client.query(
      `INSERT INTO group_members (group_id, user_id, status, invited_by) VALUES ($1, $2, 'accepted', $2)`,
      [group.id, owner_id]
    );

    if (Array.isArray(invite_usernames) && invite_usernames.length > 0) {
      for (const rawUname of invite_usernames) {
        const clean = String(rawUname).trim().toLowerCase().replace(/^@/, "");
        if (!clean) continue;
        const uRes = await client.query("SELECT id FROM users WHERE LOWER(username) = $1", [clean]);
        if (uRes.rows.length > 0 && uRes.rows[0].id !== owner_id) {
          await client.query(
            `INSERT INTO group_members (group_id, user_id, status, invited_by)
             VALUES ($1, $2, 'pending', $3)
             ON CONFLICT (group_id, user_id) DO NOTHING`,
            [group.id, uRes.rows[0].id, owner_id]
          );
        }
      }
    }

    await client.query("COMMIT");
    res.json(group);
    broadcastUpdate("group_created", { groupId: group.id });
  } catch (err: any) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Invite user to group by username (always pending confirmation)
app.post("/api/groups/:groupId/invite", async (req, res) => {
  try {
    const groupId = parseInt(req.params.groupId, 10);
    const { username, invited_by } = req.body;
    if (!username) {
      return res.status(400).json({ error: "Введите @username пользователя" });
    }
    const clean = String(username).trim().toLowerCase().replace(/^@/, "");
    const uRes = await pool.query(
      "SELECT id, username, display_name, role_title, avatar_color FROM users WHERE LOWER(username) = $1",
      [clean]
    );
    if (uRes.rows.length === 0) {
      return res.status(404).json({ error: `Пользователь @${clean} не найден` });
    }
    const targetUser = uRes.rows[0];

    const existing = await pool.query(
      "SELECT status FROM group_members WHERE group_id = $1 AND user_id = $2",
      [groupId, targetUser.id]
    );
    if (existing.rows.length > 0) {
      return res.status(400).json({
        error:
          existing.rows[0].status === "accepted"
            ? `@${clean} уже состоит в этой группе`
            : `Приглашение для @${clean} уже отправлено`,
      });
    }

    await pool.query(
      `INSERT INTO group_members (group_id, user_id, status, invited_by) VALUES ($1, $2, 'pending', $3)`,
      [groupId, targetUser.id, invited_by || null]
    );

    res.json({ message: `Приглашение отправлено @${clean}`, user: targetUser, status: "pending" });
    broadcastUpdate("group_invited", { groupId, targetUserId: targetUser.id });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Respond to group invitation (accept / decline)
app.post("/api/groups/:groupId/respond", async (req, res) => {
  try {
    const groupId = parseInt(req.params.groupId, 10);
    const { user_id, action } = req.body;
    if (action === "accept") {
      await pool.query(
        "UPDATE group_members SET status = 'accepted' WHERE group_id = $1 AND user_id = $2",
        [groupId, user_id]
      );
      res.json({ status: "accepted" });
      broadcastUpdate("group_responded", { groupId, userId: user_id, status: "accepted" });
    } else {
      await pool.query("DELETE FROM group_members WHERE group_id = $1 AND user_id = $2", [
        groupId,
        user_id,
      ]);
      res.json({ status: "declined" });
      broadcastUpdate("group_responded", { groupId, userId: user_id, status: "declined" });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Update group name and description
app.put("/api/groups/:groupId", async (req, res) => {
  try {
    const groupId = parseInt(req.params.groupId, 10);
    const { name, description } = req.body;
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: "Название группы не может быть пустым" });
    }
    const { rows } = await pool.query(
      `UPDATE groups
       SET name = $1,
           description = COALESCE($2, description)
       WHERE id = $3
       RETURNING *`,
      [String(name).trim(), description !== undefined ? String(description).trim() : null, groupId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: "Группа не найдена" });
    }
    res.json(rows[0]);
    broadcastUpdate("group_updated", { groupId });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Remove member from group (kick member, cancel pending invite, or leave group)
app.delete("/api/groups/:groupId/members/:targetUserId", async (req, res) => {
  try {
    const groupId = parseInt(req.params.groupId, 10);
    const targetUserId = parseInt(req.params.targetUserId, 10);

    const grpRes = await pool.query("SELECT * FROM groups WHERE id = $1", [groupId]);
    if (grpRes.rows.length === 0) {
      return res.status(404).json({ error: "Группа не найдена" });
    }
    const group = grpRes.rows[0];

    await pool.query("DELETE FROM group_members WHERE group_id = $1 AND user_id = $2", [
      groupId,
      targetUserId,
    ]);

    // If the owner left the group, transfer ownership to the earliest remaining accepted member, or delete if empty
    if (group.owner_id === targetUserId) {
      const remaining = await pool.query(
        "SELECT user_id FROM group_members WHERE group_id = $1 AND status = 'accepted' ORDER BY joined_at ASC LIMIT 1",
        [groupId]
      );
      if (remaining.rows.length > 0) {
        await pool.query("UPDATE groups SET owner_id = $1 WHERE id = $2", [
          remaining.rows[0].user_id,
          groupId,
        ]);
      } else {
        await pool.query("DELETE FROM groups WHERE id = $1", [groupId]);
      }
    }

    res.json({ ok: true });
    broadcastUpdate("group_member_removed", { groupId, targetUserId });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Transfer group ownership to another member
app.post("/api/groups/:groupId/transfer-owner", async (req, res) => {
  try {
    const groupId = parseInt(req.params.groupId, 10);
    const { new_owner_id } = req.body;
    if (!new_owner_id) {
      return res.status(400).json({ error: "Не указан новый владелец" });
    }
    const { rows } = await pool.query(
      "UPDATE groups SET owner_id = $1 WHERE id = $2 RETURNING *",
      [new_owner_id, groupId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: "Группа не найдена" });
    }
    res.json(rows[0]);
    broadcastUpdate("group_updated", { groupId });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Delete group completely
app.delete("/api/groups/:groupId", async (req, res) => {
  try {
    const groupId = parseInt(req.params.groupId, 10);
    await pool.query("DELETE FROM groups WHERE id = $1", [groupId]);
    res.json({ ok: true });
    broadcastUpdate("group_deleted", { groupId });
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
        "SELECT id, username, display_name, role_title, avatar_color, avatar_url, schedule_config, overrides, created_at FROM users WHERE LOWER(username) LIKE $1 ORDER BY id ASC",
        [`%${rawUname}%`]
      );
      return res.json(rows);
    }
    const { rows } = await pool.query(
      "SELECT id, username, display_name, role_title, avatar_color, avatar_url, schedule_config, overrides, created_at FROM users ORDER BY id ASC"
    );
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Set or update a single day override for a user (YYYY-MM-DD)
app.put("/api/users/:id/overrides/:date", async (req, res) => {
  try {
    const userId = parseInt(req.params.id, 10);
    const dateStr = String(req.params.date).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      return res.status(400).json({ error: "Дата должна быть в формате YYYY-MM-DD" });
    }

    const { status, slots, note } = req.body || {};
    const validStatus: "working" | "free" | "partial" =
      status === "free" || status === "partial" ? status : "working";
    const normalizedSlots: TimeSlot[] =
      validStatus === "free" || !Array.isArray(slots)
        ? []
        : slots
            .filter((s: any) => s && typeof s.start === "string" && typeof s.end === "string")
            .map((s: any) => ({
              start: s.start,
              end: s.end,
              ...(s.label ? { label: String(s.label) } : {}),
            }));

    const overrideObj = {
      status: validStatus,
      slots: normalizedSlots,
      ...(note ? { note: String(note) } : {}),
    };

    const currentRes = await pool.query("SELECT overrides FROM users WHERE id = $1", [userId]);
    if (currentRes.rows.length === 0) {
      return res.status(404).json({ error: "Пользователь не найден" });
    }

    const nextOverrides = { ...(currentRes.rows[0].overrides || {}), [dateStr]: overrideObj };
    const updated = await pool.query(
      `UPDATE users
       SET overrides = $1
       WHERE id = $2
       RETURNING id, username, display_name, role_title, avatar_color, avatar_url, banner_url, timeline_style, schedule_config, overrides`,
      [JSON.stringify(nextOverrides), userId]
    );

    broadcastUpdate("schedule_updated", { userId, dateStr });
    res.json({
      ok: true,
      date: dateStr,
      override: overrideObj,
      user: updated.rows[0],
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a single day override for a user (revert YYYY-MM-DD to base schedule)
app.delete("/api/users/:id/overrides/:date", async (req, res) => {
  try {
    const userId = parseInt(req.params.id, 10);
    const dateStr = String(req.params.date).trim();

    const currentRes = await pool.query("SELECT overrides FROM users WHERE id = $1", [userId]);
    if (currentRes.rows.length === 0) {
      return res.status(404).json({ error: "Пользователь не найден" });
    }

    const nextOverrides = { ...(currentRes.rows[0].overrides || {}) };
    delete nextOverrides[dateStr];

    const updated = await pool.query(
      `UPDATE users
       SET overrides = $1
       WHERE id = $2
       RETURNING id, username, display_name, role_title, avatar_color, avatar_url, banner_url, timeline_style, schedule_config, overrides`,
      [JSON.stringify(nextOverrides), userId]
    );

    broadcastUpdate("schedule_updated", { userId, dateStr });
    res.json({
      ok: true,
      date: dateStr,
      user: updated.rows[0],
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Patch only schedule_config for a user
app.patch("/api/users/:id/schedule", async (req, res) => {
  try {
    const userId = parseInt(req.params.id, 10);
    const currentRes = await pool.query("SELECT schedule_config FROM users WHERE id = $1", [userId]);
    if (currentRes.rows.length === 0) {
      return res.status(404).json({ error: "Пользователь не найден" });
    }

    const mergedConfig = {
      ...(currentRes.rows[0].schedule_config || {}),
      ...(req.body || {}),
    };

    const updated = await pool.query(
      `UPDATE users
       SET schedule_config = $1
       WHERE id = $2
       RETURNING id, username, display_name, role_title, avatar_color, avatar_url, banner_url, timeline_style, schedule_config, overrides`,
      [JSON.stringify(mergedConfig), userId]
    );

    broadcastUpdate("schedule_updated", { userId });
    res.json(updated.rows[0]);
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

    const { rows: memberRows } = await pool.query(
      `SELECT u.id, u.username, u.display_name, u.role_title, u.avatar_color, u.avatar_url,
              u.schedule_config, u.overrides
       FROM group_members gm
       JOIN users u ON gm.user_id = u.id
       WHERE gm.group_id = $1 AND gm.status = 'accepted'
       ORDER BY gm.joined_at ASC`,
      [groupId]
    );

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
      role_title: m.role_title,
      schedule_mode: m.schedule_config?.mode || "fixed_weekly",
      dailySchedule: days.map((d) => getUserDaySchedule(m as any, d)),
    }));

    const dailyOverlap = days.map((d) =>
      computeCombinationOverlap(activeMembers as any, d, windowStart, windowEnd, minCommonHours)
    );

    const continuousFreeWindows = computeContinuousFreeOverlap(
      activeMembers as any,
      days,
      Math.round(minCommonHours * 60)
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
