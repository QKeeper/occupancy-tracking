export interface TimeSlot {
  start: string; // "HH:MM", e.g. "09:00"
  end: string;   // "HH:MM", e.g. "18:00"
}

export interface DayWeeklySchedule {
  isWorking: boolean;
  slots: TimeSlot[];
}

export interface ShiftCycleConfig {
  workDays: number;
  offDays: number;
  startDate: string; // "YYYY-MM-DD"
  slots: TimeSlot[];
}

export interface ScheduleConfig {
  mode: "fixed_weekly" | "shift_cycle" | "manual";
  timeZone?: string;
  weekly?: {
    [dayOfWeek: string]: DayWeeklySchedule; // "0" (Sun) to "6" (Sat)
  };
  shift?: ShiftCycleConfig;
}

export interface DayOverride {
  status: "working" | "free" | "partial";
  slots: TimeSlot[];
  note?: string;
  timeZone?: string;
}

export interface OverrideMap {
  [dateStr: string]: DayOverride; // key: "YYYY-MM-DD"
}

export interface TimelineStyleConfig {
  bgColor: string;
  patternColor: string;
  patternType: "none" | "stripes" | "symbols";
  symbol: string;
  iconScale?: number;
  iconHistory?: string[];
}

export interface TimelineGroup {
  id: string; // e.g. "work", "sleep", or custom string
  name: string; // e.g. "График работы", "Сон"
  style: TimelineStyleConfig;
  schedule_config: ScheduleConfig;
  overrides?: OverrideMap;
  is_enabled?: boolean;
}

export interface User {
  revision: number;
  id: number;
  username: string;
  display_name: string;
  avatar_color: string;
  avatar_url?: string | null;
  banner_url?: string | null;
  timeline_style?: TimelineStyleConfig;
  timeline_groups?: TimelineGroup[];
  member_orders?: Record<string, number[]>;
  time_zone?: string;
  schedule_config: ScheduleConfig;
  overrides: OverrideMap;
  created_at?: string;
  is_admin?: boolean;
  is_super_admin?: boolean;
}

export interface GroupMember extends User {
  group_id: number;
  user_id: number;
  status: "accepted" | "pending";
  invited_by: number | null;
  invited_by_name?: string | null;
  invited_by_username?: string | null;
  joined_at: string;
}

export interface Group {
  id: number;
  name: string;
  description: string;
  owner_id: number;
  owner_username?: string;
  owner_name?: string;
  invite_code?: string;
  my_status: "accepted" | "pending" | null;
  invited_by_name?: string | null;
  invited_by_username?: string | null;
  members: GroupMember[];
  created_at?: string;
}

export interface GroupInviteInfo {
  id: number;
  name: string;
  description: string;
  invite_code: string;
  owner: {
    id: number;
    name: string;
    username: string;
    avatar_url: string | null;
    avatar_color: string;
  };
  members_count: number;
  members_preview: {
    user_id: number;
    username: string;
    display_name: string;
    avatar_color: string;
    avatar_url: string | null;
  }[];
  my_status: "accepted" | "pending" | null;
}

export interface ComputedDaySchedule {
  dateStr: string;
  status: "free" | "working" | "partial";
  slots: TimeSlot[];
  isOverride: boolean;
  note?: string;
  sourceLabel: string;
  busyHoursCount: number;
  freeIntervals: { start: string; end: string; durationHours: number }[];
}
