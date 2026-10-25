import { ComputedDaySchedule, TimeSlot, User } from "@/types";
import { differenceInCalendarDays, format, parseISO } from "date-fns";

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

export function getUserDaySchedule(user: User, date: Date): ComputedDaySchedule {
  const dateStr = format(date, "yyyy-MM-dd");
  const overrides = user.overrides || {};
  const config = user.schedule_config || { mode: "fixed_weekly" };

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
  minCommonHours = 2
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

  const schedules = users.map((u) => getUserDaySchedule(u, date));
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
}

/**
 * Keeps each busy slot separate, with overnight slots continuous across midnight.
 */
export function computeUserContinuousBusyBlocks(
  user: User,
  days: Date[]
): ContinuousBusyBlock[] {
  const raw: ContinuousBusyBlock[] = [];
  if (days.length === 0) return raw;

  const totalMins = days.length * 1440;
  for (let dIdx = -1; dIdx < days.length; dIdx++) {
    const day = dIdx === -1 ? new Date(days[0].getTime() - 86400000) : days[dIdx];
    const sched = getUserDaySchedule(user, day);
    const dayOffset = dIdx * 1440;

    for (const slot of sched.slots) {
      const st = timeToMinutes(slot.start);
      const en = timeToMinutes(slot.end);
      if (en > st) {
        if (dIdx >= 0) {
          raw.push({
            startMin: dayOffset + st,
            endMin: dayOffset + en,
            startTimeLabel: slot.start,
            endTimeLabel: slot.end === "00:00" ? "24:00" : slot.end,
            isOverride: sched.isOverride,
            note: sched.note,
          });
        }
      } else if (en < st) {
        // Overnight shift (e.g. 18:00 -> 09:30 next day)
        const rawStart = dayOffset + st;
        const rawEnd = dayOffset + 1440 + en;
        const clampedStart = Math.max(0, rawStart);
        const clampedEnd = Math.min(totalMins, rawEnd);
        if (clampedEnd > clampedStart) {
          raw.push({
            startMin: clampedStart,
            endMin: clampedEnd,
            startTimeLabel: slot.start,
            endTimeLabel: slot.end,
            isOverride: sched.isOverride,
            note: sched.note,
          });
        }
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
  minDurationMinutes = 60
): ContinuousInterval[] {
  const totalMins = days.length * 1440;
  if (users.length === 0 || totalMins === 0) return [];

  const allBusy: [number, number][] = [];

  for (const u of users) {
    for (let dIdx = -1; dIdx < days.length; dIdx++) {
      const day = dIdx === -1 ? new Date(days[0].getTime() - 86400000) : days[dIdx];
      const sched = getUserDaySchedule(u, day);
      const dayOffset = dIdx * 1440;
      for (const s of sched.slots) {
        const st = timeToMinutes(s.start);
        const en = timeToMinutes(s.end);
        if (en > st) {
          if (dIdx >= 0) {
            allBusy.push([dayOffset + st, dayOffset + en]);
          }
        } else if (en < st) {
          const clampedStart = Math.max(0, dayOffset + st);
          const clampedEnd = Math.min(totalMins, dayOffset + 1440 + en);
          if (clampedEnd > clampedStart) {
            allBusy.push([clampedStart, clampedEnd]);
          }
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

