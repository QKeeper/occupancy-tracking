import crypto from "node:crypto";
import type { Express, Request, Response, NextFunction } from "express";
import type { Pool, PoolClient } from "pg";

let hashingJobs = 0;
async function derive(password: string, salt: string): Promise<Buffer> {
  if (hashingJobs >= 2) throw Object.assign(new Error("Повторите попытку через несколько секунд"), { status: 503 });
  hashingJobs++;
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      crypto.scrypt(password, salt, 64, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }, (err, key) => err ? reject(err) : resolve(key));
    });
  } finally { hashingJobs--; }
}
const HASH_FORMAT = /^scrypt\$131072\$8\$1\$[a-f0-9]{32}\$[a-f0-9]{128}$/;
const digest = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const COOKIE = "syncro_session";
const TTL = 30 * 24 * 60 * 60 * 1000;
export async function hashPassword(password: string) {
  const salt = crypto.randomBytes(16).toString("hex");
  const key = await derive(password, salt);
  return `scrypt$131072$8$1$${salt}$${key.toString("hex")}`;
}
export async function verifyPassword(password: string, encoded: string) {
  if (!HASH_FORMAT.test(encoded)) return false;
  const parts = encoded.split("$");
  const key = await derive(password, parts[4]);
  return crypto.timingSafeEqual(key, Buffer.from(parts[5], "hex"));
}
export async function initAuth(client: PoolClient) {
  await client.query("BEGIN");
  try {
    await client.query(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='users'::regclass AND attname='password' AND atttypid<>'text'::regtype) THEN
        ALTER TABLE users ALTER COLUMN password TYPE TEXT;
      END IF;
      END $$;
      ALTER TABLE users ALTER COLUMN password DROP DEFAULT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 0;
      CREATE TABLE IF NOT EXISTS auth_sessions (
        token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);`);
    const { rows } = await client.query("SELECT id, password FROM users FOR UPDATE");
    for (const row of rows) {
      if (!HASH_FORMAT.test(String(row.password))) {
        await client.query("UPDATE users SET password=$1 WHERE id=$2", [await hashPassword(row.password), row.id]);
      }
    }
    await client.query("DELETE FROM auth_sessions WHERE expires_at <= CURRENT_TIMESTAMP");
    await client.query("COMMIT");
  } catch (e) { await client.query("ROLLBACK"); throw e; }
}
function cookies(req: Request): Record<string, string> {
  return Object.fromEntries((req.headers.cookie || "").split(";").map(v => v.trim().split("=")).filter(v => v.length === 2));
}
function cookieOptions(req: Request) {
  return { httpOnly: true, sameSite: "strict" as const, secure: process.env.COOKIE_SECURE === "true" || req.secure, path: "/api", maxAge: TTL };
}
export async function issueSession(pool: Pool, req: Request, res: Response, userId: number, verifiedHash?: string) {
  const previous = cookies(req)[`${COOKIE}_${userId}`];
  const token = crypto.randomBytes(32).toString("hex");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Serialize session creation with password changes, which revoke all sessions.
    const { rows } = await client.query("SELECT password FROM users WHERE id=$1 FOR UPDATE", [userId]);
    if (!rows.length || (verifiedHash !== undefined && rows[0].password !== verifiedHash)) throw Object.assign(new Error("Пароль изменился. Войдите снова"), { status: 401 });
    if (previous) await client.query("DELETE FROM auth_sessions WHERE token_hash=$1 AND user_id=$2", [digest(previous), userId]);
    await client.query("INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)", [digest(token), userId, new Date(Date.now() + TTL)]);
    await client.query("COMMIT");
  } catch (e) { await client.query("ROLLBACK"); throw e; }
  finally { client.release(); }
  res.cookie(COOKIE, token, cookieOptions(req));
  res.cookie(`${COOKIE}_${userId}`, token, cookieOptions(req));
}
export function installAuth(app: Express, pool: Pool) {
  // Safe account-card metadata is available before login; authentication status
  // is derived only from this browser's cookies, never from the supplied IDs.
  app.get("/api/auth/accounts", async (req, res, next) => {
    try {
      const ids = [...new Set(String(req.query.ids || "").split(",")
        .filter(v => /^[1-9]\d*$/.test(v)).map(Number).filter(Number.isSafeInteger))].slice(0, 100);
      res.setHeader("Cache-Control", "no-store");
      if (!ids.length) return res.json([]);
      const jar = cookies(req);
      const hashes = ids.map(id => digest(jar[`${COOKIE}_${id}`] || ""));
      const { rows } = await pool.query(`SELECT u.id,u.username,u.display_name,u.avatar_color,u.avatar_url,
        NOT EXISTS (SELECT 1 FROM auth_sessions s WHERE s.user_id=u.id AND s.token_hash=($2::text[])[array_position($1::int[],u.id)] AND s.expires_at>CURRENT_TIMESTAMP) AS "requiresPassword"
        FROM users u WHERE u.id=ANY($1::int[])`, [ids, hashes]);
      res.json(rows);
    } catch (e) { next(e); }
  });
  const attempts = new Map<string, { count: number; reset: number }>();
  const cleanup = setInterval(() => {
    for (const [key, value] of attempts) if (value.reset <= Date.now()) attempts.delete(key);
  }, 60_000);
  cleanup.unref();
  app.use("/api", (req, res, next) => {
    if (req.method !== "POST" || !/^\/auth\/(login|register)$|\/change-password$/.test(req.path)) return next();
    const key = req.ip || "unknown";
    const now = Date.now();
    const entry = attempts.get(key);
    const value = entry && entry.reset > now ? entry : { count: 0, reset: now + 15 * 60_000 };
    value.count++; attempts.set(key, value);
    if (value.count > 30) { res.setHeader("Retry-After", Math.ceil((value.reset-now)/1000)); return res.status(429).json({ error: "Слишком много попыток. Попробуйте позже" }); }
    next();
  });
  // JSON writes + Strict cookies prevent cross-site form requests. Origin is checked
  // too, including login, to prevent login CSRF. Configure public origins behind a proxy.
  app.use("/api", (req, res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    if (!req.is("application/json")) return res.status(415).json({ error: "Ожидается application/json" });
    if (req.headers["sec-fetch-site"] === "cross-site") return res.status(403).json({ error: "Запрос с другого сайта запрещён" });
    if (req.headers.origin) {
      const origins = (process.env.APP_ORIGINS || "http://localhost:5173,http://127.0.0.1:5173").split(",").map(s => s.trim());
      let sameOrigin = false;
      try { sameOrigin = new URL(req.headers.origin).origin === `${req.protocol}://${req.headers.host}`; } catch { /* invalid origin */ }
      if (!sameOrigin && !origins.includes(req.headers.origin)) return res.status(403).json({ error: "Недопустимый источник запроса" });
    }
    next();
  });
  app.use("/api", async (req: Request, res: Response, next: NextFunction) => {
    if (["/auth/login", "/auth/register", "/auth/switch", "/openapi.json", "/llms.txt"].includes(req.path)) return next();
    try {
      const token = cookies(req)[COOKIE];
      if (!token) return res.status(401).json({ error: "Войдите в аккаунт" });
      const { rows } = await pool.query("SELECT user_id FROM auth_sessions WHERE token_hash=$1 AND expires_at>CURRENT_TIMESTAMP", [digest(token)]);
      if (!rows.length) return res.status(401).json({ error: "Сессия истекла. Войдите снова" });
      res.locals.userId = rows[0].user_id;
      const ownPath = req.path.match(/^\/users\/([^/]+)(?:\/|$)/);
      if (ownPath && !["GET", "HEAD"].includes(req.method)) {
        if (!/^[1-9]\d*$/.test(ownPath[1])) return res.status(400).json({ error: "Некорректный ID пользователя" });
        if (Number(ownPath[1]) !== res.locals.userId) return res.status(403).json({ error: "Можно изменять только свой аккаунт" });
      }
      next();
    } catch (e) { next(e); }
  });
  app.post("/api/auth/switch", async (req, res, next) => {
    try {
      const userId = Number(req.body.userId);
      if (!Number.isSafeInteger(userId) || userId < 1) return res.status(400).json({ error: "Некорректный аккаунт" });
      const token = cookies(req)[`${COOKIE}_${userId}`];
      const { rows } = await pool.query("SELECT user_id FROM auth_sessions WHERE token_hash=$1 AND user_id=$2 AND expires_at>CURRENT_TIMESTAMP", [digest(token || ""), userId]);
      if (!rows.length) return res.status(401).json({ error: "Для этого аккаунта нужно снова ввести пароль" });
      res.cookie(COOKIE, token, cookieOptions(req));
      res.json({ ok: true });
    } catch (e) { next(e); }
  });
  app.post("/api/auth/logout", async (req, res, next) => {
    try {
      await pool.query("DELETE FROM auth_sessions WHERE token_hash=$1", [digest(cookies(req)[COOKIE] || "")]);
      res.clearCookie(COOKIE, { path: "/api" });
      res.clearCookie(`${COOKIE}_${res.locals.userId}`, { path: "/api" });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });
}
