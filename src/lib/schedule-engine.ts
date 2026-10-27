import { ComputedDaySchedule, DayWeeklySchedule, ScheduleConfig, TimeSlot, User } from "@/types";
import { addDays, differenceInCalendarDays, format, parseISO } from "date-fns";

export const DEFAULT_SCHEDULE_TIMEZONE = "Asia/Yekaterinburg";

export interface TimeZoneOption {
  value: string;
  city: string;
  region: string;
}

export const PRESET_TIMEZONES: TimeZoneOption[] = [
  { value: "UTC", city: "UTC / Всемирное время", region: "Мир" },
  { value: "Europe/Kaliningrad", city: "Калининград", region: "Россия (МСК-1)" },
  { value: "Europe/Moscow", city: "Москва, Санкт-Петербург", region: "Россия (МСК)" },
  { value: "Europe/Samara", city: "Самара, Ижевск, Саратов", region: "Россия (МСК+1)" },
  { value: "Asia/Yekaterinburg", city: "Екатеринбург, Уфа, Пермь, Челябинск", region: "Россия (МСК+2)" },
  { value: "Asia/Omsk", city: "Омск", region: "Россия (МСК+3)" },
  { value: "Asia/Novosibirsk", city: "Новосибирск, Красноярск, Томск", region: "Россия (МСК+4)" },
  { value: "Asia/Irkutsk", city: "Иркутск, Улан-Удэ", region: "Россия (МСК+5)" },
  { value: "Asia/Yakutsk", city: "Якутск, Чита, Благовещенск", region: "Россия (МСК+6)" },
  { value: "Asia/Vladivostok", city: "Владивосток, Хабаровск", region: "Россия (МСК+7)" },
  { value: "Asia/Magadan", city: "Магадан, Южно-Сахалинск", region: "Россия (МСК+8)" },
  { value: "Asia/Kamchatka", city: "Петропавловск-Камчатский, Анадырь", region: "Россия (МСК+9)" },
  { value: "Europe/Minsk", city: "Минск", region: "Беларусь" },
  { value: "Asia/Almaty", city: "Алматы, Астана", region: "Казахстан" },
  { value: "Asia/Tashkent", city: "Ташкент", region: "Узбекистан" },
  { value: "Asia/Bishkek", city: "Бишкек", region: "Кыргызстан" },
  { value: "Asia/Tbilisi", city: "Тбилиси", region: "Грузия" },
  { value: "Asia/Yerevan", city: "Ереван", region: "Армения" },
  { value: "Asia/Baku", city: "Баку", region: "Азербайджан" },
  { value: "Europe/London", city: "Лондон, Лиссабон", region: "Европа" },
  { value: "Europe/Berlin", city: "Берлин, Париж, Варшава, Прага", region: "Европа" },
  { value: "Europe/Istanbul", city: "Стамбул, Анталья", region: "Турция" },
  { value: "Asia/Dubai", city: "Дубай", region: "ОАЭ" },
  { value: "Asia/Kolkata", city: "Мумбаи, Нью-Дели", region: "Индия" },
  { value: "Asia/Bangkok", city: "Бангкок, Пхукет", region: "Таиланд" },
  { value: "Asia/Shanghai", city: "Пекин, Шанхай, Сингапур", region: "Азия" },
  { value: "Asia/Tokyo", city: "Токио, Сеул", region: "Азия" },
  { value: "Australia/Sydney", city: "Сидней", region: "Австралия" },
  { value: "America/New_York", city: "Нью-Йорк, Торонто", region: "Америка" },
  { value: "America/Chicago", city: "Чикаго", region: "Америка" },
  { value: "America/Denver", city: "Денвер", region: "Америка" },
  { value: "America/Los_Angeles", city: "Лос-Анджелес, Сан-Франциско", region: "Америка" },
];

export function isValidTimeZone(tz: string | null | undefined): boolean {
  if (!tz || typeof tz !== "string") return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function normalizeTimeZone(tz?: string | null): string {
  if (tz && isValidTimeZone(tz)) return tz;
  return DEFAULT_SCHEDULE_TIMEZONE;
}

const tzOffsetCache = new Map<string, number>();
const dtfByTzCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = dtfByTzCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    dtfByTzCache.set(timeZone, fmt);
  }
  return fmt;
}

/**
 * Returns the UTC offset in minutes for an IANA timeZone on the given date (e.g. +300 for UTC+5).
 */
export function getTimeZoneOffsetMinutes(
  timeZone: string,
  date: Date = new Date()
): number {
  const safeTz = normalizeTimeZone(timeZone);
  const y = date.getFullYear();
  const m = date.getMonth();
  const d = date.getDate();
  const cacheKey = `${safeTz}:${y}-${m}-${d}`;
  const cached = tzOffsetCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const probeUtc = new Date(Date.UTC(y, m, d, 12, 0, 0));
  const parts = getFormatter(safeTz).formatToParts(probeUtc);
  let py = y,
    pm = m + 1,
    pd = d,
    ph = 12,
    pmin = 0,
    ps = 0;
  for (const p of parts) {
    if (p.type === "year") py = Number(p.value);
    else if (p.type === "month") pm = Number(p.value);
    else if (p.type === "day") pd = Number(p.value);
    else if (p.type === "hour") ph = Number(p.value);
    else if (p.type === "minute") pmin = Number(p.value);
    else if (p.type === "second") ps = Number(p.value);
  }
  const zonedMs = Date.UTC(py, pm - 1, pd, ph === 24 ? 0 : ph, pmin, ps);
  const offsetMins = Math.round((zonedMs - probeUtc.getTime()) / 60000);
  tzOffsetCache.set(cacheKey, offsetMins);
  return offsetMins;
}

export function formatUtcOffset(offsetMins: number, padded = false): string {
  const sign = offsetMins >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMins);
  const hh = Math.floor(abs / 60);
  const mm = abs % 60;
  const hhStr = padded ? String(hh).padStart(2, "0") : String(hh);
  if (mm === 0) {
    return padded ? `UTC${sign}${hhStr}:00` : `UTC${sign}${hhStr}`;
  }
  return `UTC${sign}${hhStr}:${String(mm).padStart(2, "0")}`;
}

export function formatTimeZoneShort(timeZone?: string | null): string {
  const safeTz = normalizeTimeZone(timeZone);
  const offsetMins = getTimeZoneOffsetMinutes(safeTz);
  const preset = PRESET_TIMEZONES.find((p) => p.value === safeTz);
  const shortCity = preset ? preset.city.split(",")[0] : safeTz.split("/").pop()?.replace(/_/g, " ") || safeTz;
  return `${formatUtcOffset(offsetMins)} • ${shortCity}`;
}

export function formatTimeZoneOptionLabel(opt: TimeZoneOption, date?: Date): string {
  const offsetMins = getTimeZoneOffsetMinutes(opt.value, date);
  return `(${formatUtcOffset(offsetMins, true)}) ${opt.city} — ${opt.value}`;
}

export function getAvailableTimeZoneOptions(currentTz?: string | null): TimeZoneOption[] {
  const list = [...PRESET_TIMEZONES];
  const extras = new Set<string>();
  if (currentTz && isValidTimeZone(currentTz)) extras.add(currentTz);
  try {
    const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (browserTz && isValidTimeZone(browserTz)) extras.add(browserTz);
  } catch {
    // ignore
  }
  for (const tz of extras) {
    if (!list.some((item) => item.value === tz)) {
      list.push({
        value: tz,
        city: tz.split("/").pop()?.replace(/_/g, " ") || tz,
        region: "Локальный пояс",
      });
    }
  }
  return list.sort(
    (a, b) => getTimeZoneOffsetMinutes(a.value) - getTimeZoneOffsetMinutes(b.value)
  );
}

/**
 * Returns current calendar date ("YYYY-MM-DD") and time-of-day in the given IANA timezone.
 */
export function getNowInTimeZone(
  timeZone?: string | null,
  now: Date = new Date()
): { dateStr: string; hours: number; minutes: number; totalMinutes: number } {
  const safeTz = normalizeTimeZone(timeZone);
  const parts = getFormatter(safeTz).formatToParts(now);
  let y = "2026",
    m = "01",
    d = "01",
    hh = 0,
    mm = 0;
  for (const p of parts) {
    if (p.type === "year") y = p.value;
    else if (p.type === "month") m = p.value;
    else if (p.type === "day") d = p.value;
    else if (p.type === "hour") hh = Number(p.value) % 24;
    else if (p.type === "minute") mm = Number(p.value);
  }
  return {
    dateStr: `${y}-${m}-${d}`,
    hours: hh,
    minutes: mm,
    totalMinutes: hh * 60 + mm,
  };
}

/**
 * Converts a ScheduleConfig from its stored timeZone into targetTimeZone so the user can view/edit
 * their base schedule in their currently selected profile timezone.
 */
export function convertScheduleConfigTimeZone(
  config: ScheduleConfig,
  targetTimeZone?: string | null
): ScheduleConfig {
  const targetTz = normalizeTimeZone(targetTimeZone);
  const sourceTz = normalizeTimeZone(config.timeZone);
  const deltaMins =
    getTimeZoneOffsetMinutes(targetTz) - getTimeZoneOffsetMinutes(sourceTz);

  if (deltaMins === 0) {
    return { ...config, timeZone: targetTz };
  }

  let nextWeekly = config.weekly;
  if (config.weekly) {
    const shiftedWeekly: Record<string, DayWeeklySchedule> = {
      "0": { isWorking: false, slots: [] },
      "1": { isWorking: false, slots: [] },
      "2": { isWorking: false, slots: [] },
      "3": { isWorking: false, slots: [] },
      "4": { isWorking: false, slots: [] },
      "5": { isWorking: false, slots: [] },
      "6": { isWorking: false, slots: [] },
    };

    for (const [dayKey, daySched] of Object.entries(config.weekly)) {
      if (!daySched?.isWorking || !daySched.slots?.length) continue;
      const dayNum = Number(dayKey);
      for (const slot of daySched.slots) {
        const st = timeToMinutes(slot.start);
        const en = timeToMinutes(slot.end);
        const dur = en > st ? en - st : 1440 - st + en;
        if (dur <= 0) continue;

        const shiftedSt = st + deltaMins;
        const dayShift = Math.floor(shiftedSt / 1440);
        const targetDay = String((((dayNum + dayShift) % 7) + 7) % 7);
        const newStartMin = ((shiftedSt % 1440) + 1440) % 1440;
        const newEndRaw = newStartMin + dur;
        const newEndMod = ((newEndRaw % 1440) + 1440) % 1440;

        shiftedWeekly[targetDay].isWorking = true;
        shiftedWeekly[targetDay].slots.push({
          ...slot,
          start: minutesToTime(newStartMin),
          end: newEndRaw === 1440 ? "24:00" : minutesToTime(newEndMod),
        });
      }
    }
    nextWeekly = shiftedWeekly;
  }

  let nextShift = config.shift;
  if (config.shift) {
    let startDate = config.shift.startDate;
    const rawSlots = config.shift.slots || [];
    let primaryDayShift = 0;
    const shiftedSlots: TimeSlot[] = rawSlots.map((slot, idx) => {
      const st = timeToMinutes(slot.start);
      const en = timeToMinutes(slot.end);
      const dur = en > st ? en - st : 1440 - st + en;
      const shiftedSt = st + deltaMins;
      const dayShift = Math.floor(shiftedSt / 1440);
      if (idx === 0) primaryDayShift = dayShift;
      const newStartMin = ((shiftedSt % 1440) + 1440) % 1440;
      const newEndRaw = newStartMin + dur;
      const newEndMod = ((newEndRaw % 1440) + 1440) % 1440;
      return {
        ...slot,
        start: minutesToTime(newStartMin),
        end: newEndRaw === 1440 ? "24:00" : minutesToTime(newEndMod),
      };
    });

    if (primaryDayShift !== 0 && startDate) {
      const parsed = parseISO(startDate);
      if (!Number.isNaN(parsed.getTime())) {
        startDate = format(addDays(parsed, primaryDayShift), "yyyy-MM-dd");
      }
    }

    nextShift = {
      ...config.shift,
      startDate,
      slots: shiftedSlots,
    };
  }

  return {
    ...config,
    timeZone: targetTz,
    ...(nextWeekly ? { weekly: nextWeekly } : {}),
    ...(nextShift ? { shift: nextShift } : {}),
  };
}

export function timeToMinutes(t: string): number {
  const [hh, mm] = t.split(":").map(Number);
  return (hh || 0) * 60 + (mm || 0);
}

export function minutesToTime(mins: number): string {
  const clamped = Math.max(0, Math.min(24 * 60, mins));
  const hh = Math.floor(clamped / 60);
  const mm = clamped % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

export function computeBusyHours(slots: TimeSlot[]): number {
  let totalMins = 0;
  for (const s of slots) {
    const start = timeToMinutes(s.start);
    const end = timeToMinutes(s.end);
    if (end > start) {
      totalMins += end - start;
    } else if (end < start) {
      // Overnight shift
      totalMins += 24 * 60 - start + end;
    }
  }
  return Math.round((totalMins / 60) * 10) / 10;
}

/**
 * Given busy slots within waking hours (default 09:00 to 23:00),
 * returns free intervals in [windowStart, windowEnd]
 */
export function computeFreeIntervals(
  busySlots: TimeSlot[],
  windowStart = "09:00",
  windowEnd = "23:00"
): { start: string; end: string; durationHours: number }[] {
  const wStart = timeToMinutes(windowStart);
  const wEnd = timeToMinutes(windowEnd);

  // Convert busy slots to [startMin, endMin]
  const busyRanges: [number, number][] = [];
  for (const s of busySlots) {
    const st = timeToMinutes(s.start);
    const en = timeToMinutes(s.end);
    if (en > st) {
      busyRanges.push([Math.max(wStart, st), Math.min(wEnd, en)]);
    } else if (en < st) {
      // Overnight split
      busyRanges.push([Math.max(wStart, st), wEnd]);
      busyRanges.push([wStart, Math.min(wEnd, en)]);
    }
  }

  const validBusy = busyRanges
    .filter(([st, en]) => en > st)
    .sort((a, b) => a[0] - b[0]);

  // Merge overlapping busy intervals
  const merged: [number, number][] = [];
  for (const range of validBusy) {
    if (merged.length === 0 || merged[merged.length - 1][1] < range[0]) {
      merged.push([...range]);
    } else {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], range[1]);
    }
  }

  // Subtract merged busy from [wStart, wEnd]
  const free: { start: string; end: string; durationHours: number }[] = [];
  let cursor = wStart;

  for (const [bStart, bEnd] of merged) {
    if (bStart > cursor) {
      const dur = Math.round(((bStart - cursor) / 60) * 10) / 10;
      if (dur >= 1) {
        free.push({
          start: minutesToTime(cursor),
          end: minutesToTime(bStart),
          durationHours: dur,
        });
      }
    }
    cursor = Math.max(cursor, bEnd);
  }

  if (cursor < wEnd) {
    const dur = Math.round(((wEnd - cursor) / 60) * 10) / 10;
    if (dur >= 1) {
      free.push({
        start: minutesToTime(cursor),
        end: minutesToTime(wEnd),
        durationHours: dur,
      });
    }
  }

  return free;
}

interface RawDaySchedule extends ComputedDaySchedule {
  timeZone: string;
}

function getRawUserDaySchedule(user: User, date: Date): RawDaySchedule {
  const dateStr = format(date, "yyyy-MM-dd");
  const overrides = user.overrides || {};
  const config = user.schedule_config || { mode: "fixed_weekly" };
  const baseTimeZone = normalizeTimeZone(config.timeZone);

  // 1. Check explicit manual override on this date
  if (overrides[dateStr]) {
    const ov = overrides[dateStr];
    const slots = ov.status === "free" ? [] : ov.slots || [];
    const busyHoursCount = computeBusyHours(slots);
    const status =
      ov.status === "free" || slots.length === 0
        ? "free"
        : ov.status === "partial" || busyHoursCount <= 5
        ? "partial"
        : "working";

    return {
      dateStr,
      status,
      slots,
      isOverride: true,
      note: ov.note,
      sourceLabel: "Ручная правка",
      busyHoursCount,
      freeIntervals: computeFreeIntervals(slots),
      timeZone: normalizeTimeZone(ov.timeZone),
    };
  }

  // 2. Check mode
  if (config.mode === "shift_cycle" && config.shift) {
    const { workDays = 2, offDays = 2, startDate, slots = [] } = config.shift;
    const cycleLen = Math.max(1, workDays + offDays);
    let isWorkDay = false;
    if (startDate) {
      const start = parseISO(startDate);
      const diff = differenceInCalendarDays(date, start);
      const mod = ((diff % cycleLen) + cycleLen) % cycleLen;
      isWorkDay = mod < workDays;
    }

    const activeSlots = isWorkDay ? slots : [];
    const busyHoursCount = computeBusyHours(activeSlots);
    return {
      dateStr,
      status: !isWorkDay ? "free" : busyHoursCount <= 5 ? "partial" : "working",
      slots: activeSlots,
      isOverride: false,
      sourceLabel: `Сменный ${workDays}/${offDays}`,
      busyHoursCount,
      freeIntervals: computeFreeIntervals(activeSlots),
      timeZone: baseTimeZone,
    };
  }

  if (config.mode === "fixed_weekly" && config.weekly) {
    const dayIndex = String(date.getDay()); // "0".."6"
    const dayCfg = config.weekly[dayIndex];
    const isWorking = dayCfg?.isWorking ?? false;
    const activeSlots = isWorking ? dayCfg?.slots || [] : [];
    const busyHoursCount = computeBusyHours(activeSlots);

    return {
      dateStr,
      status: !isWorking || activeSlots.length === 0 ? "free" : busyHoursCount <= 5 ? "partial" : "working",
      slots: activeSlots,
      isOverride: false,
      sourceLabel: "Недельный график",
      busyHoursCount,
      freeIntervals: computeFreeIntervals(activeSlots),
      timeZone: baseTimeZone,
    };
  }

  // 3. Manual mode with no override on this date -> Free
  return {
    dateStr,
    status: "free",
    slots: [],
    isOverride: false,
    sourceLabel: "Свободный график",
    busyHoursCount: 0,
    freeIntervals: computeFreeIntervals([]),
    timeZone: baseTimeZone,
  };
}

export function getUserDaySchedule(
  user: User,
  date: Date,
  viewerTimeZone?: string
): ComputedDaySchedule {
  const rawToday = getRawUserDaySchedule(user, date);
  const { timeZone: _rawTz, ...baseToday } = rawToday;
  if (!viewerTimeZone) {
    return baseToday;
  }

  const targetTz = normalizeTimeZone(viewerTimeZone);
  const neighbors = [-1, 0, 1].map((offset) => {
    const d = offset === 0 ? date : addDays(date, offset);
    const sched = offset === 0 ? rawToday : getRawUserDaySchedule(user, d);
    const deltaMins =
      getTimeZoneOffsetMinutes(targetTz, d) - getTimeZoneOffsetMinutes(sched.timeZone, d);
    return { offset, sched, deltaMins };
  });

  if (neighbors.every((n) => n.deltaMins === 0)) {
    return baseToday;
  }

  const effectiveBusySlotsToday: TimeSlot[] = [];

  for (const { offset, sched, deltaMins } of neighbors) {
    const dayOffset = offset * 1440;
    for (const slot of sched.slots) {
      const st = timeToMinutes(slot.start);
      const en = timeToMinutes(slot.end);
      if (en === st) continue;
      const rawStart = dayOffset + st;
      const rawEnd = dayOffset + (en > st ? en : 1440 + en);
      const shiftedStart = rawStart + deltaMins;
      const shiftedEnd = rawEnd + deltaMins;

      const clampedStart = Math.max(0, shiftedStart);
      const clampedEnd = Math.min(1440, shiftedEnd);
      if (clampedEnd > clampedStart) {
        effectiveBusySlotsToday.push({
          ...slot,
          start: minutesToTime(clampedStart),
          end: clampedEnd === 1440 ? "24:00" : minutesToTime(clampedEnd),
        });
      }
    }
  }

  const slots = effectiveBusySlotsToday;
  const busyHoursCount = computeBusyHours(slots);
  const status =
    slots.length === 0 && effectiveBusySlotsToday.length === 0
      ? "free"
      : (rawToday.isOverride && rawToday.status === "partial") || busyHoursCount <= 5
      ? "partial"
      : "working";

  return {
    dateStr: baseToday.dateStr,
    status,
    slots,
    isOverride: baseToday.isOverride,
    note: baseToday.note,
    sourceLabel: baseToday.sourceLabel,
    busyHoursCount,
    freeIntervals: computeFreeIntervals(effectiveBusySlotsToday),
  };
}

export interface DayCombinationOverlap {
  dateStr: string;
  allFreeFullDay: boolean;
  allHaveCommonWindow: boolean;
  commonFreeWindows: { start: string; end: string; durationHours: number }[];
  availableMembersCount: number;
  totalSelectedCount: number;
}

/**
 * Computes intersection of free time across a selected subset of users on a given date
 * within target time window (e.g., "09:00" - "23:00" or evening "18:00" - "23:00").
 */
export function computeCombinationOverlap(
  users: User[],
  date: Date,
  windowStart = "09:00",
  windowEnd = "23:00",
  minCommonHours = 2,
  viewerTimeZone?: string
): DayCombinationOverlap {
  const dateStr = format(date, "yyyy-MM-dd");
  if (users.length === 0) {
    return {
      dateStr,
      allFreeFullDay: false,
      allHaveCommonWindow: false,
      commonFreeWindows: [],
      availableMembersCount: 0,
      totalSelectedCount: 0,
    };
  }

  const schedules = users.map((u) => getUserDaySchedule(u, date, viewerTimeZone));
  const allFreeFullDay = schedules.every((s) => s.status === "free");

  // Combine all busy slots of all selected users to find when EVERYONE is simultaneously free
  const combinedBusySlots: TimeSlot[] = [];
  let availableMembersCount = 0;

  for (const s of schedules) {
    combinedBusySlots.push(...s.slots);
    const memberFreeInWindow = computeFreeIntervals(s.slots, windowStart, windowEnd);
    const maxFree = memberFreeInWindow.reduce((acc, cur) => Math.max(acc, cur.durationHours), 0);
    if (maxFree >= minCommonHours) {
      availableMembersCount++;
    }
  }

  const commonFreeWindows = computeFreeIntervals(combinedBusySlots, windowStart, windowEnd).filter(
    (w) => w.durationHours >= minCommonHours
  );

  return {
    dateStr,
    allFreeFullDay,
    allHaveCommonWindow: commonFreeWindows.length > 0,
    commonFreeWindows,
    availableMembersCount,
    totalSelectedCount: users.length,
  };
}

export interface ContinuousInterval {
  startMin: number; // 0 .. days.length * 1440
  endMin: number;
  startTimeLabel: string; // "HH:MM"
  endTimeLabel: string;   // "HH:MM"
}

export interface ContinuousBusyBlock extends ContinuousInterval {
  isOverride: boolean;
  note?: string;
  sourceDate?: Date;
}

/**
 * Keeps each busy slot separate, with overnight slots and timezone shifts continuous across midnight.
 */
export function computeUserContinuousBusyBlocks(
  user: User,
  days: Date[],
  viewerTimeZone?: string
): ContinuousBusyBlock[] {
  const raw: ContinuousBusyBlock[] = [];
  if (days.length === 0) return raw;

  const targetTz = viewerTimeZone ? normalizeTimeZone(viewerTimeZone) : null;
  const totalMins = days.length * 1440;
  const minDIdx = targetTz ? -2 : -1;
  const maxDIdx = targetTz ? days.length : days.length - 1;

  for (let dIdx = minDIdx; dIdx <= maxDIdx; dIdx++) {
    const day = dIdx >= 0 && dIdx < days.length ? days[dIdx] : addDays(days[0], dIdx);
    const sched = getRawUserDaySchedule(user, day);
    const dayOffset = dIdx * 1440;
    const deltaMins = targetTz
      ? getTimeZoneOffsetMinutes(targetTz, day) - getTimeZoneOffsetMinutes(sched.timeZone, day)
      : 0;

    for (const slot of sched.slots) {
      const st = timeToMinutes(slot.start);
      const en = timeToMinutes(slot.end);
      if (en === st) continue;

      const isOvernight = en < st;
      if (deltaMins === 0 && !isOvernight && dIdx < 0) continue;

      const rawStart = dayOffset + st;
      const rawEnd = dayOffset + (en > st ? en : 1440 + en);
      const shiftedStart = rawStart + deltaMins;
      const shiftedEnd = rawEnd + deltaMins;

      const clampedStart = Math.max(0, shiftedStart);
      const clampedEnd = Math.min(totalMins, shiftedEnd);
      if (clampedEnd > clampedStart) {
        const startMod = ((shiftedStart % 1440) + 1440) % 1440;
        const endMod = ((shiftedEnd % 1440) + 1440) % 1440;
        const startTimeLabel = deltaMins === 0 ? slot.start : minutesToTime(startMod);
        const endTimeLabel =
          deltaMins === 0
            ? !isOvernight && slot.end === "00:00"
              ? "24:00"
              : slot.end
            : endMod === 0
            ? "24:00"
            : minutesToTime(endMod);

        raw.push({
          startMin: clampedStart,
          endMin: clampedEnd,
          startTimeLabel,
          endTimeLabel,
          isOverride: sched.isOverride,
          note: sched.note,
          sourceDate: day,
        });
      }
    }
  }

  raw.sort((a, b) => a.startMin - b.startMin);

  return raw;
}

export interface TimelineBusyBlock extends ContinuousBusyBlock {
  lane: number;
  laneCount: number;
}

/** Pack overlapping slots into lanes, sharing height only within each overlap group. */
export function layoutBusyBlocks(blocks: ContinuousBusyBlock[]): TimelineBusyBlock[] {
  const sorted = [...blocks].sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);
  const result: TimelineBusyBlock[] = [];
  let group: TimelineBusyBlock[] = [];
  let groupEnd = -Infinity;
  let laneEnds: number[] = [];
  const finishGroup = () => {
    for (const block of group) block.laneCount = laneEnds.length;
  };

  for (const block of sorted) {
    if (block.startMin >= groupEnd) {
      finishGroup();
      group = [];
      laneEnds = [];
      groupEnd = -Infinity;
    }
    let lane = laneEnds.findIndex((end) => end <= block.startMin);
    if (lane === -1) lane = laneEnds.length;
    laneEnds[lane] = block.endMin;
    groupEnd = Math.max(groupEnd, block.endMin);
    const placed = { ...block, lane, laneCount: 1 };
    group.push(placed);
    result.push(placed);
  }
  finishGroup();
  return result;
}

/**
 * Computes continuous common free windows across the entire multi-day timeline [0 .. days.length * 1440]
 * without breaking at 00:00 midnight boundaries.
 */
export function computeContinuousFreeOverlap(
  users: User[],
  days: Date[],
  minDurationMinutes = 60,
  viewerTimeZone?: string
): ContinuousInterval[] {
  const totalMins = days.length * 1440;
  if (users.length === 0 || totalMins === 0) return [];

  const targetTz = viewerTimeZone ? normalizeTimeZone(viewerTimeZone) : null;
  const minDIdx = targetTz ? -2 : -1;
  const maxDIdx = targetTz ? days.length : days.length - 1;
  const allBusy: [number, number][] = [];

  for (const u of users) {
    for (let dIdx = minDIdx; dIdx <= maxDIdx; dIdx++) {
      const day = dIdx >= 0 && dIdx < days.length ? days[dIdx] : addDays(days[0], dIdx);
      const sched = getRawUserDaySchedule(u, day);
      const dayOffset = dIdx * 1440;
      const deltaMins = targetTz
        ? getTimeZoneOffsetMinutes(targetTz, day) - getTimeZoneOffsetMinutes(sched.timeZone, day)
        : 0;

      for (const s of sched.slots) {
        const st = timeToMinutes(s.start);
        const en = timeToMinutes(s.end);
        if (en === st) continue;
        const isOvernight = en < st;
        if (deltaMins === 0 && !isOvernight && dIdx < 0) continue;

        const rawStart = dayOffset + st + deltaMins;
        const rawEnd = dayOffset + (en > st ? en : 1440 + en) + deltaMins;
        const clampedStart = Math.max(0, rawStart);
        const clampedEnd = Math.min(totalMins, rawEnd);
        if (clampedEnd > clampedStart) {
          allBusy.push([clampedStart, clampedEnd]);
        }
      }
    }
  }

  allBusy.sort((a, b) => a[0] - b[0]);

  const mergedBusy: [number, number][] = [];
  for (const [st, en] of allBusy) {
    if (mergedBusy.length === 0 || mergedBusy[mergedBusy.length - 1][1] < st) {
      mergedBusy.push([st, en]);
    } else {
      mergedBusy[mergedBusy.length - 1][1] = Math.max(
        mergedBusy[mergedBusy.length - 1][1],
        en
      );
    }
  }

  const free: ContinuousInterval[] = [];
  let cursor = 0;

  for (const [bStart, bEnd] of mergedBusy) {
    if (bStart > cursor) {
      if (bStart - cursor >= minDurationMinutes) {
        free.push({
          startMin: cursor,
          endMin: bStart,
          startTimeLabel: minutesToTime(cursor % 1440),
          endTimeLabel: minutesToTime(bStart % 1440),
        });
      }
    }
    cursor = Math.max(cursor, bEnd);
  }

  if (cursor < totalMins && totalMins - cursor >= minDurationMinutes) {
    free.push({
      startMin: cursor,
      endMin: totalMins,
      startTimeLabel: minutesToTime(cursor % 1440),
      endTimeLabel: minutesToTime(totalMins % 1440),
    });
  }

  return free;
}

