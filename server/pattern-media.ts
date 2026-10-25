import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import sharp from "sharp";
import type { PoolClient } from "pg";
import type { Express } from "express";
import { z } from "zod";
import { HttpError } from "./group-routes";

const iconPath = /^\/uploads\/icon_[a-f0-9]{20}\.(png|svg|webp|gif|jpe?g)$/;
export function createPatternMedia(uploadsDir: string) {
  async function saveIcon(value: string): Promise<string> {
    let input: Buffer;
    if (value.startsWith("data:")) {
      const match = value.match(/^data:image\/(png|svg\+xml|webp|gif|jpe?g)(;base64)?,(.+)$/s);
      if (!match) throw new HttpError(400, "Поддерживаются изображения SVG, PNG, WebP, GIF и JPEG");
      try { input = match[2] ? Buffer.from(match[3], "base64") : Buffer.from(decodeURIComponent(match[3]), "utf8"); }
      catch { throw new HttpError(400, "Некорректное изображение" ); }
    } else if (iconPath.test(value)) {
      try { input = await fs.readFile(path.join(uploadsDir, path.basename(value))); }
      catch { throw new HttpError(400, "Файл иконки не найден" ); }
    } else {
      if (value.startsWith("/") || value.includes(":") || value.length > 64) throw new HttpError(400, "Некорректная иконка");
      return value; // Emoji and text symbols stay as text.
    }
    if (input.length > 2 * 1024 * 1024) throw new HttpError(400, "Иконка должна быть меньше 2 МБ");
    let png: Buffer;
    try {
      // Store a self-contained raster, preserving alpha and avoiding executable SVG.
      png = await sharp(input, { limitInputPixels: 16_777_216 }).resize(96, 96, { fit: "inside", withoutEnlargement: true }).png().toBuffer();
    } catch { throw new HttpError(400, "Не удалось прочитать изображение иконки"); }
    const hash = crypto.createHash("sha256").update(png).digest("hex").slice(0, 20);
    const filename = `icon_${hash}.png`;
    await fs.writeFile(path.join(uploadsDir, filename), png, { flag: "wx" }).catch(e => { if (e.code !== "EEXIST") throw e; });
    return `/uploads/${filename}`;
  }
  async function normalizeStyle<T extends { symbol?: string; iconHistory?: string[] }>(style: T): Promise<T> {
    const values = new Map<string, string>();
    for (const value of [style.symbol, ...(style.iconHistory || [])]) {
      if (typeof value === "string" && !values.has(value)) values.set(value, await saveIcon(value));
    }
    return { ...style,
      ...(style.symbol !== undefined ? { symbol: values.get(style.symbol)! } : {}),
      ...(style.iconHistory ? { iconHistory: [...new Set(style.iconHistory.map(v => values.get(v)!))] } : {}),
    };
  }
  async function migrate(client: PoolClient) {
    await client.query("BEGIN");
    try {
      const { rows } = await client.query("SELECT id,timeline_style FROM users FOR UPDATE");
      for (const row of rows) {
        const next = await normalizeStyle(row.timeline_style);
        if (JSON.stringify(next) !== JSON.stringify(row.timeline_style)) {
          await client.query("UPDATE users SET timeline_style=$1,revision=revision+1 WHERE id=$2", [JSON.stringify(next), row.id]);
        }
      }
      await client.query("COMMIT");
    } catch (e) { await client.query("ROLLBACK"); throw e; }
  }
  function install(app: Express) {
    app.get("/api/pattern-tile", async (req, res, next) => {
      try {
        const { icon, color, scale } = z.object({
          icon: z.string().regex(/^\/uploads\/icon_[a-f0-9]{20}\.png$/),
          color: z.string().regex(/^#[a-f0-9]{6}$/i), scale: z.coerce.number().min(0.5).max(2.2),
        }).parse(req.query);
        let png: Buffer;
        try { png = await fs.readFile(path.join(uploadsDir, path.basename(icon))); }
        catch { throw new HttpError(404, "Иконка не найдена"); }
        const image = `data:image/png;base64,${png.toString("base64")}`;
        const size1 = Math.round(13 * scale * 10) / 10;
        const size2 = Math.round(11 * scale * 10) / 10;
        // SVG images cannot fetch external images. Embed the PNG in the generated
        // response, while keeping only its file URL in the database.
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="52" height="44" viewBox="0 0 52 44"><defs><filter id="t" x="-30%" y="-30%" width="160%" height="160%"><feFlood flood-color="${color}" flood-opacity="0.4" result="c"/><feComposite in="c" in2="SourceAlpha" operator="in"/></filter></defs><g filter="url(#t)"><image href="${image}" x="${14-size1/2}" y="${13-size1/2}" width="${size1}" height="${size1}" preserveAspectRatio="xMidYMid meet" transform="rotate(-14 14 13)"/><image href="${image}" x="${40-size2/2}" y="${33-size2/2}" width="${size2}" height="${size2}" preserveAspectRatio="xMidYMid meet" transform="rotate(12 40 33)"/></g></svg>`;
        res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
        res.type("image/svg+xml").send(svg);
      } catch (e) { next(e); }
    });
  }
  return { saveIcon, normalizeStyle, migrate, install };
}
