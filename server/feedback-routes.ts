import type { Express, Request, Response, NextFunction } from "express";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { HttpError } from "./group-routes";
import { isSuperAdminUsername } from "./admin-routes";

export async function initFeedback(client: PoolClient) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS feedback_items (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title VARCHAR(255) NOT NULL DEFAULT '',
      message TEXT NOT NULL,
      tags JSONB NOT NULL DEFAULT '[]'::jsonb,
      status VARCHAR(32) NOT NULL DEFAULT 'open',
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS feedback_likes (
      feedback_id INTEGER NOT NULL REFERENCES feedback_items(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (feedback_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS feedback_comments (
      id SERIAL PRIMARY KEY,
      feedback_id INTEGER NOT NULL REFERENCES feedback_items(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      message TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_feedback_items_status ON feedback_items(status);
    CREATE INDEX IF NOT EXISTS idx_feedback_items_created_at ON feedback_items(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_feedback_likes_feedback_id ON feedback_likes(feedback_id);
    CREATE INDEX IF NOT EXISTS idx_feedback_comments_feedback_id ON feedback_comments(feedback_id, created_at ASC);
  `);
}

async function isUserAdminOrSuper(pool: Pool | PoolClient, userId: number): Promise<boolean> {
  const { rows } = await pool.query("SELECT is_admin, username FROM users WHERE id=$1", [userId]);
  if (!rows.length) return false;
  return Boolean(rows[0].is_admin || isSuperAdminUsername(rows[0].username));
}

const createFeedbackSchema = z.object({
  title: z.string().trim().min(2, "Заголовок должен содержать не менее 2 символов").max(200, "Заголовок слишком длинный"),
  message: z.string().trim().max(5000, "Описание слишком длинное").default(""),
  tags: z.array(z.string().trim().min(1).max(50)).max(10).default([]),
});

const commentSchema = z.object({
  message: z.string().trim().min(1, "Комментарий не может быть пустым").max(2000, "Комментарий слишком длинный"),
});

const idSchema = z.coerce.number().int().positive();

async function getFeedbackItemById(pool: Pool, feedbackId: number, currentUserId: number) {
  const query = `
    SELECT
      f.id,
      f.user_id,
      u.display_name AS author_name,
      u.username AS author_username,
      u.avatar_color AS author_avatar_color,
      u.avatar_url AS author_avatar_url,
      f.title,
      f.message,
      f.tags,
      f.status,
      f.created_at,
      COALESCE(likes.cnt, 0)::int AS likes_count,
      EXISTS(SELECT 1 FROM feedback_likes fl WHERE fl.feedback_id = f.id AND fl.user_id = $2) AS has_liked,
      COALESCE(comments_agg.cnt, 0)::int AS comments_count,
      COALESCE(comments_agg.comments, '[]'::json) AS comments
    FROM feedback_items f
    JOIN users u ON u.id = f.user_id
    LEFT JOIN (
      SELECT feedback_id, COUNT(*)::int AS cnt FROM feedback_likes GROUP BY feedback_id
    ) likes ON likes.feedback_id = f.id
    LEFT JOIN (
      SELECT 
        c.feedback_id,
        COUNT(*)::int AS cnt,
        json_agg(
          json_build_object(
            'id', c.id,
            'feedback_id', c.feedback_id,
            'user_id', c.user_id,
            'author_name', cu.display_name,
            'author_username', cu.username,
            'author_avatar_color', cu.avatar_color,
            'author_avatar_url', cu.avatar_url,
            'message', c.message,
            'created_at', c.created_at
          ) ORDER BY c.created_at ASC
        ) AS comments
      FROM feedback_comments c
      JOIN users cu ON cu.id = c.user_id
      GROUP BY c.feedback_id
    ) comments_agg ON comments_agg.feedback_id = f.id
    WHERE f.id = $1
  `;
  const { rows } = await pool.query(query, [feedbackId, currentUserId]);
  if (!rows.length) return null;
  const item = rows[0];
  item.tags = Array.isArray(item.tags) ? item.tags : [];
  item.comments = Array.isArray(item.comments) ? item.comments : [];
  return item;
}

export function installFeedbackRoutes(
  app: Express,
  pool: Pool,
  broadcast: (type: string, payload?: any) => void
) {
  // GET /api/feedback: List all feedback tickets with filters
  app.get("/api/feedback", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const currentUserId = res.locals.userId;
      const statusParam = typeof req.query.status === "string" ? req.query.status.trim().toLowerCase() : "all";
      const tagParam = typeof req.query.tag === "string" && req.query.tag.trim() ? req.query.tag.trim() : null;
      const searchParam = typeof req.query.search === "string" && req.query.search.trim() ? req.query.search.trim() : null;

      const query = `
        SELECT
          f.id,
          f.user_id,
          u.display_name AS author_name,
          u.username AS author_username,
          u.avatar_color AS author_avatar_color,
          u.avatar_url AS author_avatar_url,
          f.title,
          f.message,
          f.tags,
          f.status,
          f.created_at,
          COALESCE(likes.cnt, 0)::int AS likes_count,
          EXISTS(SELECT 1 FROM feedback_likes fl WHERE fl.feedback_id = f.id AND fl.user_id = $1) AS has_liked,
          COALESCE(comments_agg.cnt, 0)::int AS comments_count,
          COALESCE(comments_agg.comments, '[]'::json) AS comments
        FROM feedback_items f
        JOIN users u ON u.id = f.user_id
        LEFT JOIN (
          SELECT feedback_id, COUNT(*)::int AS cnt FROM feedback_likes GROUP BY feedback_id
        ) likes ON likes.feedback_id = f.id
        LEFT JOIN (
          SELECT 
            c.feedback_id,
            COUNT(*)::int AS cnt,
            json_agg(
              json_build_object(
                'id', c.id,
                'feedback_id', c.feedback_id,
                'user_id', c.user_id,
                'author_name', cu.display_name,
                'author_username', cu.username,
                'author_avatar_color', cu.avatar_color,
                'author_avatar_url', cu.avatar_url,
                'message', c.message,
                'created_at', c.created_at
              ) ORDER BY c.created_at ASC
            ) AS comments
          FROM feedback_comments c
          JOIN users cu ON cu.id = c.user_id
          GROUP BY c.feedback_id
        ) comments_agg ON comments_agg.feedback_id = f.id
        WHERE ($2::text IS NULL OR ($2 = 'open' AND f.status = 'open') OR ($2 = 'closed' AND f.status = 'closed') OR $2 = 'all')
          AND ($3::text IS NULL OR f.tags::text ILIKE '%' || $3 || '%')
          AND ($4::text IS NULL OR f.title ILIKE '%' || $4 || '%' OR f.message ILIKE '%' || $4 || '%' OR u.display_name ILIKE '%' || $4 || '%' OR u.username ILIKE '%' || $4 || '%')
        ORDER BY f.created_at DESC
      `;

      const { rows } = await pool.query(query, [
        currentUserId,
        statusParam === "all" ? null : statusParam,
        tagParam,
        searchParam,
      ]);

      const items = rows.map((r) => ({
        ...r,
        tags: Array.isArray(r.tags) ? r.tags : [],
        comments: Array.isArray(r.comments) ? r.comments : [],
      }));

      res.json(items);
    } catch (e) {
      next(e);
    }
  });

  // POST /api/feedback: Create new feedback ticket
  app.post("/api/feedback", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const actor = res.locals.userId;
      const parsed = createFeedbackSchema.parse(req.body);

      const { rows: inserted } = await pool.query(
        "INSERT INTO feedback_items (user_id, title, message, tags) VALUES ($1, $2, $3, $4::jsonb) RETURNING id",
        [actor, parsed.title, parsed.message, JSON.stringify(parsed.tags)]
      );
      const newId = inserted[0].id;

      broadcast("feedback_updated", { action: "create", id: newId });

      const item = await getFeedbackItemById(pool, newId, actor);
      res.status(201).json(item);
    } catch (e) {
      next(e);
    }
  });

  // DELETE /api/feedback/:id: Delete feedback ticket (owner or admin)
  app.delete("/api/feedback/:id", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const actor = res.locals.userId;
      const feedbackId = idSchema.parse(req.params.id);
      const { rows } = await pool.query("SELECT id, user_id FROM feedback_items WHERE id=$1", [feedbackId]);
      if (!rows.length) throw new HttpError(404, "Обращение не найдено");

      const isOwner = rows[0].user_id === actor;
      const isAdmin = await isUserAdminOrSuper(pool, actor);
      if (!isOwner && !isAdmin) {
        throw new HttpError(403, "Удалять обращение может только его автор или администратор");
      }

      await pool.query("DELETE FROM feedback_items WHERE id=$1", [feedbackId]);
      broadcast("feedback_updated", { action: "delete", id: feedbackId });
      res.json({ ok: true, id: feedbackId });
    } catch (e) {
      next(e);
    }
  });

  // PATCH /api/feedback/:id/status: Change status (open/closed)
  app.patch("/api/feedback/:id/status", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const actor = res.locals.userId;
      const feedbackId = idSchema.parse(req.params.id);
      const status = z.enum(["open", "closed"]).parse(req.body.status);

      const { rows } = await pool.query("SELECT id, user_id FROM feedback_items WHERE id=$1", [feedbackId]);
      if (!rows.length) throw new HttpError(404, "Обращение не найдено");

      const isOwner = rows[0].user_id === actor;
      const isAdmin = await isUserAdminOrSuper(pool, actor);
      if (!isOwner && !isAdmin) {
        throw new HttpError(403, "Изменять статус может только автор обращения или администратор");
      }

      await pool.query("UPDATE feedback_items SET status=$1, updated_at=CURRENT_TIMESTAMP WHERE id=$2", [
        status,
        feedbackId,
      ]);
      broadcast("feedback_updated", { action: "status", id: feedbackId, status });

      const item = await getFeedbackItemById(pool, feedbackId, actor);
      res.json(item);
    } catch (e) {
      next(e);
    }
  });

  // POST /api/feedback/:id/like: Toggle like on feedback
  app.post("/api/feedback/:id/like", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const actor = res.locals.userId;
      const feedbackId = idSchema.parse(req.params.id);

      const { rows: exists } = await pool.query("SELECT id FROM feedback_items WHERE id=$1", [feedbackId]);
      if (!exists.length) throw new HttpError(404, "Обращение не найдено");

      const { rows: hasLiked } = await pool.query(
        "SELECT 1 FROM feedback_likes WHERE feedback_id=$1 AND user_id=$2",
        [feedbackId, actor]
      );

      let liked = false;
      if (hasLiked.length) {
        await pool.query("DELETE FROM feedback_likes WHERE feedback_id=$1 AND user_id=$2", [feedbackId, actor]);
        liked = false;
      } else {
        await pool.query("INSERT INTO feedback_likes (feedback_id, user_id) VALUES ($1, $2)", [feedbackId, actor]);
        liked = true;
      }

      const { rows: countRows } = await pool.query(
        "SELECT COUNT(*)::int AS cnt FROM feedback_likes WHERE feedback_id=$1",
        [feedbackId]
      );
      const likesCount = countRows[0]?.cnt || 0;

      broadcast("feedback_updated", { action: "like", id: feedbackId, liked, likes_count: likesCount });
      res.json({ ok: true, liked, likes_count: likesCount });
    } catch (e) {
      next(e);
    }
  });

  // POST /api/feedback/:id/comments: Add comment to feedback
  app.post("/api/feedback/:id/comments", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const actor = res.locals.userId;
      const feedbackId = idSchema.parse(req.params.id);
      const parsed = commentSchema.parse(req.body);

      const { rows: exists } = await pool.query("SELECT id FROM feedback_items WHERE id=$1", [feedbackId]);
      if (!exists.length) throw new HttpError(404, "Обращение не найдено");

      const { rows: inserted } = await pool.query(
        "INSERT INTO feedback_comments (feedback_id, user_id, message) VALUES ($1, $2, $3) RETURNING id, created_at",
        [feedbackId, actor, parsed.message]
      );
      const commentId = inserted[0].id;

      const { rows: userRows } = await pool.query(
        "SELECT display_name, username, avatar_color, avatar_url FROM users WHERE id=$1",
        [actor]
      );
      const author = userRows[0];

      const comment = {
        id: commentId,
        feedback_id: feedbackId,
        user_id: actor,
        author_name: author.display_name,
        author_username: author.username,
        author_avatar_color: author.avatar_color,
        author_avatar_url: author.avatar_url,
        message: parsed.message,
        created_at: inserted[0].created_at,
      };

      broadcast("feedback_updated", { action: "comment", feedbackId, commentId });
      res.status(201).json(comment);
    } catch (e) {
      next(e);
    }
  });

  // DELETE /api/feedback/comments/:commentId: Delete comment (owner or admin)
  app.delete("/api/feedback/comments/:commentId", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const actor = res.locals.userId;
      const commentId = idSchema.parse(req.params.commentId);

      const { rows } = await pool.query("SELECT id, feedback_id, user_id FROM feedback_comments WHERE id=$1", [commentId]);
      if (!rows.length) throw new HttpError(404, "Комментарий не найден");

      const isOwner = rows[0].user_id === actor;
      const isAdmin = await isUserAdminOrSuper(pool, actor);
      if (!isOwner && !isAdmin) {
        throw new HttpError(403, "Удалять комментарий может только его автор или администратор");
      }

      await pool.query("DELETE FROM feedback_comments WHERE id=$1", [commentId]);
      broadcast("feedback_updated", { action: "comment_delete", feedbackId: rows[0].feedback_id, commentId });
      res.json({ ok: true, id: commentId });
    } catch (e) {
      next(e);
    }
  });
}
