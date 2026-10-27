import { z } from "zod";

export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => {
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s;
}, "Несуществующая дата");
const startTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Неверное время начала");
const endTime = z.string().regex(/^(([01]\d|2[0-3]):[0-5]\d|24:00)$/, "Неверное время окончания");
export const slotSchema = z.object({ start: startTime, end: endTime, label: z.string().max(500).optional() })
  .strict().refine((s) => s.start !== s.end, "Начало и конец интервала совпадают");
const slotsSchema = z.array(slotSchema).max(100);
const weeklySchema = z.record(z.string().regex(/^[0-6]$/), z.object({
  isWorking: z.boolean(), slots: slotsSchema,
}).strict());
const shiftSchema = z.object({
  workDays: z.number().int().min(1).max(366), offDays: z.number().int().min(0).max(366),
  startDate: dateSchema, slots: slotsSchema,
}).strict();
export const timeZoneSchema = z.string().trim().min(1).max(128).refine((tz) => {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, "Некорректный часовой пояс");
export const scheduleFieldsSchema = z.object({
  mode: z.enum(["fixed_weekly", "shift_cycle", "manual"]),
  timeZone: timeZoneSchema.optional(),
  weekly: weeklySchema.optional(), shift: shiftSchema.optional(),
}).strict();
export const scheduleSchema = scheduleFieldsSchema.superRefine((v, ctx) => {
  if (v.mode === "fixed_weekly" && !v.weekly) ctx.addIssue({ code: "custom", message: "Нужен недельный график", path: ["weekly"] });
  if (v.mode === "shift_cycle" && !v.shift) ctx.addIssue({ code: "custom", message: "Нужен сменный график", path: ["shift"] });
});
export const overrideSchema = z.object({
  status: z.enum(["working", "partial", "free"]), slots: slotsSchema, note: z.string().max(2000).optional(),
  timeZone: timeZoneSchema.optional(),
}).strict().refine(v => v.status !== "free" || v.slots.length === 0, "Свободный день не должен содержать интервалы");
export const usernameSchema = z.string().trim().transform(s => s.replace(/^@/, "").toLowerCase())
  .pipe(z.string().min(2).max(32).regex(/^[a-z0-9_.-]+$/i, "Недопустимый логин"));
export const passwordSchema = z.string().min(4).max(1024);
export const revisionSchema = z.number().int().nonnegative();
const color = z.string().regex(/^#[0-9a-f]{6}$/i);
export const styleSchema = z.object({
  bgColor: color, patternColor: color, patternType: z.enum(["none", "stripes", "symbols"]),
  symbol: z.string().max(2_000_000), iconScale: z.number().min(0.5).max(2.2).optional(),
  iconHistory: z.array(z.string().max(2_000_000)).max(15).optional(),
}).strict();
export const profileSchema = z.object({
  revision: revisionSchema,
  username: usernameSchema.optional(), display_name: z.string().trim().min(1).max(128).optional(),
  avatar_color: color.optional(),
  avatar_url: z.string().max(20_000_000).nullable().optional(),
  banner_url: z.string().max(20_000_000).nullable().optional(),
  time_zone: timeZoneSchema.optional(),
  timeline_style: styleSchema.optional(), schedule_config: scheduleSchema.optional(),
}).strict();
