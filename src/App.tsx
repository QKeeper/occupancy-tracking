import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { User, Group, DayOverride } from "@/types";
import { OccupancyCalendarGrid } from "@/components/OccupancyCalendarGrid";
import { TimelineGroupsModal } from "@/components/TimelineGroupsModal";
import { FeedbackModal } from "@/components/FeedbackModal";
import { DayOverrideModal } from "@/components/DayOverrideModal";
import { CreateGroupModal, GroupSettingsModal } from "@/components/GroupModals";
import { GroupInviteModal } from "@/components/GroupInviteModal";
import { AgentApiView } from "@/components/AgentApiView";
import { AdminDashboardView } from "@/components/AdminDashboardView";
import {
  AuthModal,
  ProfileCabinetModal,
  AVATAR_COLORS,
  SavedAccount,
} from "@/components/AuthModal";
import {
  formatTimeZoneShort,
  getNowInTimeZone,
  DEFAULT_SCHEDULE_TIMEZONE,
} from "@/lib/schedule-engine";
import { loginSchema, registerSchema, extractZodErrors } from "@/lib/validators";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Label } from "@/components/ui/label";
import { addDays, startOfWeek, format } from "date-fns";
import { ru } from "date-fns/locale/ru";
import { Toaster, toast } from "sonner";
import {
  Calendar as CalendarIcon,
  ChevronLeft,
  ChevronRight,
  UserPlus,
  Plus,
  Settings,
  Settings2,
  Sun,
  Moon,
  Bell,
  Check,
  X,
  User as UserIcon,
  Bot,
  Globe,
  Layers,
  MessageSquarePlus,
  ShieldCheck,
  Crown,
} from "lucide-react";

const STORAGE_USER_ID_KEY = "syncro_active_user_id";
const STORAGE_GROUP_ID_KEY = "syncro_active_group_id";
const STORAGE_THEME_KEY = "syncro_dark_mode";
const STORAGE_WEEK_START_KEY = "syncro_timeline_week_start";
const STORAGE_DAYS_SPAN_KEY = "syncro_timeline_days_span";
const STORAGE_DAY_OFFSET_KEY = "syncro_timeline_day_offset";
const STORAGE_SAVED_ACCOUNTS_KEY = "syncro_saved_accounts";
const STORAGE_MEMBER_ORDERS_KEY = "syncro_member_orders";

function persistSavedAccounts(accounts: SavedAccount[]) {
  try {
    // Store only lightweight fields in localStorage to avoid QuotaExceededError on large base64 GIF/PNG avatars
    const compact = accounts.map(({ id, username, display_name, avatar_color, avatar_url }) => ({
      id,
      username,
      display_name,
      avatar_color,
      avatar_url: avatar_url?.startsWith("data:") ? undefined : avatar_url,
    }));
    localStorage.setItem(STORAGE_SAVED_ACCOUNTS_KEY, JSON.stringify(compact));
  } catch (err) {
    console.warn("Failed to persist saved accounts:", err);
  }
}

export function App() {
  const [darkMode, setDarkMode] = useState<boolean>(() => {
    const saved = localStorage.getItem(STORAGE_THEME_KEY);
    return saved !== null ? saved === "true" : true;
  });
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [savedAccounts, setSavedAccounts] = useState<SavedAccount[]>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_SAVED_ACCOUNTS_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map(acc => ({ ...acc, requiresPassword: true })) : [];
    } catch {
      return [];
    }
  });
  const [groups, setGroups] = useState<Group[]>([]);
  const [memberOrders, setMemberOrders] = useState<Record<string, number[]>>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_MEMBER_ORDERS_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  });
  const [activeGroupId, setActiveGroupId] = useState<number | null>(() => {
    const saved = localStorage.getItem(STORAGE_GROUP_ID_KEY);
    return saved ? parseInt(saved, 10) : null;
  });
  const [loading, setLoading] = useState(true);
  const [inviteCode, setInviteCode] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    const pathMatch = window.location.pathname.match(/^\/(?:invite|join)\/([a-zA-Z0-9_-]+)/);
    const searchCode = new URLSearchParams(window.location.search).get("invite");
    return pathMatch ? pathMatch[1] : searchCode;
  });

  // Unauthenticated screen form states
  const [loginUsername, setLoginUsername] = useState("");
  const [unauthTab, setUnauthTab] = useState("login");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginErrors, setLoginErrors] = useState<Record<string, string>>({});

  const [regUsername, setRegUsername] = useState("");
  const [regName, setRegName] = useState("");
  const [regPassword, setRegPassword] = useState("");
  const [regConfirmPassword, setRegConfirmPassword] = useState("");
  const [regColor, setRegColor] = useState("#3B82F6");
  const [regErrors, setRegErrors] = useState<Record<string, string>>({});
  const [authSubmitting, setAuthSubmitting] = useState(false);

  const [weekStart, setWeekStart] = useState<Date>(() => {
    const saved = localStorage.getItem(STORAGE_WEEK_START_KEY);
    if (saved) {
      const d = new Date(saved);
      if (!Number.isNaN(d.getTime())) return d;
    }
    return startOfWeek(new Date(), { weekStartsOn: 1 });
  });
  const [daysSpan, setDaysSpan] = useState<7 | 14>(() => {
    const saved = localStorage.getItem(STORAGE_DAYS_SPAN_KEY);
    return saved === "14" ? 14 : 7;
  });
  const currentTimelineDayOffsetRef = useRef<number>(0);
  const [scrollCommand, setScrollCommand] = useState<{
    type: "today" | "preserve-day" | "week-nav";
    targetDayOffset?: number;
    seq: number;
  }>(() => {
    const savedOffset = localStorage.getItem(STORAGE_DAY_OFFSET_KEY);
    const parsedOffset = savedOffset !== null ? Number(savedOffset) : NaN;
    if (!Number.isNaN(parsedOffset) && parsedOffset >= 0) {
      return { type: "preserve-day", targetDayOffset: parsedOffset, seq: 0 };
    }
    return { type: "today", seq: 0 };
  });

  useEffect(() => {
    localStorage.setItem(STORAGE_WEEK_START_KEY, weekStart.toISOString());
  }, [weekStart]);

  useEffect(() => {
    localStorage.setItem(STORAGE_DAYS_SPAN_KEY, String(daysSpan));
  }, [daysSpan]);

  const handleChangeDaysSpan = (nextSpan: 7 | 14) => {
    if (nextSpan === daysSpan) return;
    const currentOffset = currentTimelineDayOffsetRef.current;

    if (daysSpan === 14 && nextSpan === 7 && currentOffset >= 6.5) {
      setWeekStart((d) => addDays(d, 7));
      setDaysSpan(7);
      setScrollCommand((prev) => ({
        type: "preserve-day",
        targetDayOffset: Math.max(0, currentOffset - 7),
        seq: prev.seq + 1,
      }));
      return;
    }

    setDaysSpan(nextSpan);
    setScrollCommand((prev) => ({
      type: "preserve-day",
      targetDayOffset: currentOffset,
      seq: prev.seq + 1,
    }));
  };

  const [selectedMemberIds, setSelectedMemberIds] = useState<number[]>([]);
  const [adminMode, setAdminMode] = useState<boolean>(() => {
    const path = window.location.pathname.toLowerCase();
    const params = new URLSearchParams(window.location.search);
    return path === "/admin" || params.get("admin") === "1";
  });
  const [agentMode, setAgentMode] = useState<boolean>(() => {
    const path = window.location.pathname.toLowerCase();
    const params = new URLSearchParams(window.location.search);
    return (
      path === "/agent" ||
      path === "/openapi" ||
      path === "/api-docs" ||
      params.get("agent") === "1" ||
      params.get("openapi") === "1"
    );
  });

  const toggleAdminMode = (next: boolean) => {
    setAdminMode(next);
    if (next) setAgentMode(false);
    const url = new URL(window.location.href);
    if (next) {
      url.searchParams.set("admin", "1");
      url.searchParams.delete("agent");
      url.searchParams.delete("openapi");
    } else {
      url.searchParams.delete("admin");
      if (url.pathname.toLowerCase() === "/admin") {
        url.pathname = "/";
      }
    }
    window.history.replaceState({}, "", url.toString());
  };

  const toggleAgentMode = (next: boolean) => {
    setAgentMode(next);
    if (next) setAdminMode(false);
    const url = new URL(window.location.href);
    if (next) {
      url.searchParams.set("agent", "1");
      url.searchParams.delete("admin");
    } else {
      url.searchParams.delete("agent");
      url.searchParams.delete("openapi");
      if (["/agent", "/openapi", "/api-docs"].includes(url.pathname.toLowerCase())) {
        url.pathname = "/";
      }
    }
    window.history.replaceState({}, "", url.toString());
  };

  const [profileModalOpen, setProfileModalOpen] = useState(false);
  const [createGroupOpen, setCreateGroupOpen] = useState(false);
  const [groupSettingsState, setGroupSettingsState] = useState<{
    open: boolean;
    tab: "members" | "settings";
  }>({ open: false, tab: "members" });
  const [cabinetModalOpen, setCabinetModalOpen] = useState(false);
  const [feedbackModalOpen, setFeedbackModalOpen] = useState(false);
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [authUsername, setAuthUsername] = useState("");
  const [overrideTarget, setOverrideTarget] = useState<{
    user: User | null;
    date: Date | null;
    groupId?: string;
    open: boolean;
  }>({ user: null, date: null, open: false });

  const currentUserRef = useRef<User | null>(null);
  currentUserRef.current = currentUser;
  const activeGroupIdRef = useRef<number | null>(activeGroupId);
  activeGroupIdRef.current = activeGroupId;

  useEffect(() => {
    localStorage.setItem(STORAGE_THEME_KEY, String(darkMode));
    if (darkMode) {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
    }
  }, [darkMode]);

  const fetchAllData = useCallback(async (preferredUserId?: number, preferredGroupId?: number) => {
    try {
      const uRes = await fetch("/api/auth/me");
      const activeIdentity = uRes.ok ? await uRes.clone().json() : null;
      const targetUserId = activeIdentity?.id;
      const gRes = targetUserId ? await fetch(`/api/groups?userId=${targetUserId}`) : null;

      if (!uRes.ok) {
        // Stored user no longer exists -> log out
        localStorage.removeItem(STORAGE_USER_ID_KEY);
        setCurrentUser(null);
        setGroups([]);
        setLoading(false);
        return;
      }

      const [activeUser, groupsData]: [User, Group[]] = await Promise.all([
        uRes.json(),
        gRes?.ok ? gRes.json() : [],
      ]);

      setCurrentUser(activeUser);
      localStorage.setItem(STORAGE_USER_ID_KEY, String(activeUser.id));

      setSavedAccounts((prev) => {
        const entry: SavedAccount = {
          id: activeUser.id,
          username: activeUser.username,
          display_name: activeUser.display_name,
          avatar_color: activeUser.avatar_color,
          avatar_url: activeUser.avatar_url,
          requiresPassword: false,
        };
        const existsIdx = prev.findIndex((a) => a.id === activeUser.id);
        let next: SavedAccount[];
        if (existsIdx >= 0) {
          next = prev.map((a, idx) => (idx === existsIdx ? entry : a));
        } else {
          next = [...prev, entry];
        }
        persistSavedAccounts(next);
        return next;
      });

      setGroups(groupsData);

      const acceptedGroups = groupsData.filter((g) => g.my_status === "accepted");
      if (acceptedGroups.length > 0) {
        const targetGrpId = preferredGroupId ?? activeGroupIdRef.current;
        const stillExists = acceptedGroups.find((g) => g.id === targetGrpId);
        const nextGroup = stillExists || acceptedGroups[0];
        setActiveGroupId(nextGroup.id);
        localStorage.setItem(STORAGE_GROUP_ID_KEY, String(nextGroup.id));
      } else {
        setActiveGroupId(null);
      }
    } catch (err) {
      console.error("Failed to fetch data:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAllData();
  }, [fetchAllData]);

  const savedAccountIds = savedAccounts.map(account => account.id).join(",");
  // Refresh before login too. The endpoint returns only card metadata and verifies
  // remembered sessions against this browser's HttpOnly cookies.
  useEffect(() => {
    if (!savedAccountIds) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const res = await fetch(`/api/auth/accounts?ids=${savedAccountIds}`, { cache: "no-store" });
        if (!res.ok) return;
        const rows: SavedAccount[] = await res.json();
        if (cancelled || !Array.isArray(rows)) return;
        const byId = new Map(rows.map(account => [account.id, account]));
        setSavedAccounts(prev => {
          const next = prev.map(account => byId.get(account.id) ?? { ...account, requiresPassword: true });
          persistSavedAccounts(next);
          return next;
        });
      } catch { /* Keep cached cards when offline. */ }
    };
    void refresh();
    window.addEventListener("focus", refresh);
    const timer = window.setInterval(refresh, 60_000);
    return () => { cancelled = true; window.removeEventListener("focus", refresh); window.clearInterval(timer); };
  }, [savedAccountIds, currentUser?.id]);

  // Real-time Server-Sent Events (SSE) subscription
  useEffect(() => {
    if (!currentUser) return;
    const evtSource = new EventSource("/api/events");
    evtSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type && data.type !== "connected" && currentUserRef.current) {
          fetchAllData(currentUserRef.current.id);
        }
      } catch {
        // ignore
      }
    };
    return () => {
      evtSource.close();
    };
  }, [fetchAllData, currentUser?.id]);

  const activeGroup = useMemo(
    () => groups.find((g) => g.id === activeGroupId && g.my_status === "accepted") || null,
    [groups, activeGroupId]
  );

  const pendingInvites = useMemo(
    () => groups.filter((g) => g.my_status === "pending"),
    [groups]
  );

  const groupMembers = useMemo<User[]>(() => {
    if (!activeGroup) return currentUser ? [currentUser] : [];
    const baseMembers: User[] = activeGroup.members
      .filter((m) => m.status === "accepted")
      .map((m) => {
        const isCurrent = m.user_id === currentUser?.id;
        return {
          id: m.user_id,
          username: m.username,
          display_name: isCurrent && currentUser.display_name ? currentUser.display_name : m.display_name,
          avatar_color: isCurrent && currentUser.avatar_color ? currentUser.avatar_color : m.avatar_color,
          avatar_url: isCurrent ? (currentUser.avatar_url ?? m.avatar_url) : m.avatar_url,
          banner_url: isCurrent ? (currentUser.banner_url ?? m.banner_url) : m.banner_url,
          timeline_style: isCurrent ? (currentUser.timeline_style || m.timeline_style) : m.timeline_style,
          time_zone: isCurrent ? (currentUser.time_zone || m.time_zone) : m.time_zone,
          schedule_config: isCurrent ? (currentUser.schedule_config || m.schedule_config) : m.schedule_config,
          overrides: isCurrent ? (currentUser.overrides || m.overrides) : m.overrides,
          revision: isCurrent ? (currentUser.revision ?? m.revision) : m.revision,
          timeline_groups: isCurrent
            ? (currentUser.timeline_groups ?? m.timeline_groups)
            : m.timeline_groups,
        };
      });

    const localKey = currentUser ? `${currentUser.id}:${activeGroup.id}` : `${activeGroup.id}`;
    const savedOrder =
      memberOrders[localKey] ||
      currentUser?.member_orders?.[String(activeGroup.id)];

    if (!Array.isArray(savedOrder) || savedOrder.length === 0) {
      return baseMembers;
    }

    const orderIdx = new Map<number, number>();
    savedOrder.forEach((uid, idx) => orderIdx.set(Number(uid), idx));

    return [...baseMembers].sort((a, b) => {
      const idxA = orderIdx.get(a.id);
      const idxB = orderIdx.get(b.id);
      if (idxA !== undefined && idxB !== undefined) return idxA - idxB;
      if (idxA !== undefined) return -1;
      if (idxB !== undefined) return 1;
      return 0;
    });
  }, [activeGroup, currentUser, memberOrders]);

  const handleReorderMembers = useCallback(
    (newMemberIds: number[]) => {
      if (!currentUser || !activeGroup) return;
      const groupKey = String(activeGroup.id);
      const localKey = `${currentUser.id}:${activeGroup.id}`;

      setMemberOrders((prev) => {
        const next = { ...prev, [localKey]: newMemberIds };
        try {
          localStorage.setItem(STORAGE_MEMBER_ORDERS_KEY, JSON.stringify(next));
        } catch {
          // ignore
        }
        return next;
      });

      setCurrentUser((prev) =>
        prev
          ? {
              ...prev,
              member_orders: {
                ...(prev.member_orders || {}),
                [groupKey]: newMemberIds,
              },
            }
          : prev
      );

      fetch(`/api/users/${currentUser.id}/member-order`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groupKey, memberIds: newMemberIds }),
      }).then(async (res) => {
        if (!res.ok) throw new Error("Не удалось сохранить порядок участников");
        const data = await res.json();
        setCurrentUser(prev => prev?.id === currentUser.id ? { ...prev, revision: Math.max(prev.revision, data.revision) } : prev);
      }).catch(() => toast.error("Не удалось сохранить порядок участников"));
    },
    [currentUser, activeGroup]
  );

  const days = useMemo(() => {
    return Array.from({ length: daysSpan }, (_, idx) => addDays(weekStart, idx));
  }, [weekStart, daysSpan]);

  const handleToggleMemberFilter = (userId: number) => {
    setSelectedMemberIds((prev) =>
      prev.includes(userId) ? prev.filter((id) => id !== userId) : [...prev, userId]
    );
  };

  const handleSaveUserProfile = async (updated: Partial<User>) => {
    if (!currentUser) return;
    const res = await fetch(`/api/users/${currentUser.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ revision: currentUser.revision, ...updated }),
    });
    const data = await res.json();
    if (!res.ok) { if (res.status === 409) await fetchAllData(currentUser.id); throw new Error(data.error || "Не удалось обновить профиль"); }
    await fetchAllData(currentUser.id);
  };

  const handleSaveDayOverride = async (
    userId: number,
    dateStr: string,
    override: DayOverride | null,
    expectedOverride?: DayOverride | null,
    groupId?: string
  ) => {
    if (!currentUser || userId !== currentUser.id) {
      toast.error("Редактировать можно только свой собственный график");
      return;
    }

    const res = await fetch(`/api/users/${currentUser.id}/overrides/${dateStr}`, {
      method: override === null ? "DELETE" : "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedOverride:
          expectedOverride === undefined
            ? (groupId && groupId !== "work"
                ? currentUser.timeline_groups?.find((g) => g.id === groupId)?.overrides?.[dateStr] ?? null
                : currentUser.overrides?.[dateStr] ?? null)
            : expectedOverride,
        ...(override === null ? {} : { override }),
        ...(groupId ? { groupId } : {}),
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      if (res.status === 409) await fetchAllData(currentUser.id);
      throw new Error(data.error || "Ошибка сохранения дня");
    }
    await fetchAllData(currentUser.id);
  };

  const handleRespondInvite = async (groupId: number, action: "accept" | "decline") => {
    if (!currentUser) return;
    try {
      const res = await fetch(`/api/groups/${groupId}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: currentUser.id, action }),
      });
      if (!res.ok) throw new Error("Ошибка ответа на приглашение");
      toast.success(action === "accept" ? "Вы вступили в группу" : "Приглашение отклонено");
      await fetchAllData(currentUser.id, action === "accept" ? groupId : undefined);
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  const handleDirectLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginErrors({});

    const parsed = loginSchema.safeParse({
      username: loginUsername,
      password: loginPassword,
    });
    if (!parsed.success) {
      setLoginErrors(extractZodErrors(parsed.error));
      return;
    }

    setAuthSubmitting(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Ошибка входа");
      setAuthModalOpen(false);
      setCabinetModalOpen(false);
      setLoginPassword("");
      localStorage.setItem(STORAGE_USER_ID_KEY, String(data.id));
      toast.success(`Вы вошли как @${data.username}`);
      await fetchAllData(data.id);
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setAuthSubmitting(false);
    }
  };

  const handleDirectRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setRegErrors({});

    const parsed = registerSchema.safeParse({
      username: regUsername,
      display_name: regName,
      password: regPassword,
      confirmPassword: regConfirmPassword,
      avatar_color: regColor,
    });
    if (!parsed.success) {
      setRegErrors(extractZodErrors(parsed.error));
      return;
    }

    setAuthSubmitting(true);
    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: parsed.data.username,
          display_name: parsed.data.display_name,
          password: parsed.data.password,
          avatar_color: parsed.data.avatar_color,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Ошибка регистрации");
      setAuthModalOpen(false);
      setCabinetModalOpen(false);
      setLoginPassword("");
      localStorage.setItem(STORAGE_USER_ID_KEY, String(data.id));
      toast.success(`Аккаунт @${data.username} создан`);
      await fetchAllData(data.id);
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setAuthSubmitting(false);
    }
  };

  const handleCloseInvite = useCallback(() => {
    setInviteCode(null);
    if (typeof window !== "undefined") {
      if (window.location.pathname.startsWith("/invite/") || window.location.pathname.startsWith("/join/")) {
        window.history.replaceState({}, "", "/");
      } else if (new URLSearchParams(window.location.search).has("invite")) {
        const url = new URL(window.location.href);
        url.searchParams.delete("invite");
        window.history.replaceState({}, "", url.pathname + (url.search ? url.search : ""));
      }
    }
  }, []);

  const handleJoinedGroupFromInvite = useCallback(async (joinedGroupId: number) => {
    handleCloseInvite();
    setActiveGroupId(joinedGroupId);
    localStorage.setItem(STORAGE_GROUP_ID_KEY, String(joinedGroupId));
    setSelectedMemberIds([]);
    await fetchAllData(currentUserRef.current?.id, joinedGroupId);
  }, [fetchAllData, handleCloseInvite]);

  const handleLogout = async () => {
    const response = await fetch("/api/auth/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    if (!response.ok && response.status !== 401) { toast.error("Не удалось завершить сессию"); return; }
    localStorage.removeItem(STORAGE_USER_ID_KEY);
    localStorage.removeItem(STORAGE_GROUP_ID_KEY);
    setCurrentUser(null);
    setGroups([]);
    setActiveGroupId(null);
    setSelectedMemberIds([]);
  };

  const promptSavedAccountLogin = (account: SavedAccount) => {
    setAuthUsername(account.username);
    setLoginUsername(account.username);
    setLoginPassword("");
    setLoginErrors({});
    setUnauthTab("login");
    setCabinetModalOpen(false);
    // The initial login page already contains a form; do not leave a hidden
    // modal flag that would open after successful authentication.
    setAuthModalOpen(Boolean(currentUser));
  };

  const handleSelectSavedAccount = async (accountId: number) => {
    const account = savedAccounts.find(item => item.id === accountId);
    if (!account) return;
    if (account.requiresPassword) { promptSavedAccountLogin(account); return; }
    try {
      const response = await fetch("/api/auth/switch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId: accountId }) });
      if (response.status === 401) {
        setSavedAccounts(prev => prev.map(item => item.id === accountId ? { ...item, requiresPassword: true } : item));
        promptSavedAccountLogin(account);
        return;
      }
      if (!response.ok) throw new Error("Не удалось переключить аккаунт");
      setAuthModalOpen(false);
      setCabinetModalOpen(false);
      localStorage.setItem(STORAGE_USER_ID_KEY, String(accountId));
      setSelectedMemberIds([]);
      await fetchAllData(accountId);
    } catch (err: any) { toast.error(err.message || "Ошибка переключения аккаунта"); }
  };

  const handleRemoveSavedAccount = (accountId: number) => {
    setSavedAccounts((prev) => {
      const next = prev.filter((a) => a.id !== accountId);
      persistSavedAccounts(next);
      return next;
    });
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <p className="text-sm text-muted-foreground">Загрузка...</p>
      </div>
    );
  }

  // Initial unauthenticated state: clean shadcn login/register card (or OpenAPI view if requested)
  if (!currentUser) {
    if (agentMode) {
      return (
        <div className="min-h-screen bg-background text-foreground p-4 sm:p-6">
          <Toaster position="top-right" />
          <AgentApiView
            currentUser={null}
            groups={[]}
            activeGroup={null}
            groupMembers={[]}
            days={days}
            onSelectGroup={() => {}}
            onSaveDayOverride={handleSaveDayOverride}
            onSaveUserProfile={handleSaveUserProfile}
            onRefreshData={() => fetchAllData()}
            onCloseAgentView={() => toggleAgentMode(false)}
          />
        </div>
      );
    }

    return (
      <div className="min-h-screen bg-background text-foreground flex flex-col justify-center items-center p-4">
        <Toaster position="top-right" />
        <div className="w-full max-w-sm rounded-lg border border-border bg-card p-6 shadow-sm space-y-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 font-semibold text-base">
              <CalendarIcon className="size-4" />
              <span>Syncro</span>
            </div>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="xs"
                onClick={() => toggleAgentMode(true)}
                data-testid="toggle-agent-view-unauth"
                title="OpenAPI и интерфейс для ИИ-агентов"
              >
                <Bot className="size-3.5" />
                OpenAPI
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setDarkMode(!darkMode)}
                className="size-8"
                aria-label="Тема"
              >
                {darkMode ? <Sun className="size-4" /> : <Moon className="size-4" />}
              </Button>
            </div>
          </div>

          {savedAccounts.length > 0 && (
            <div className="space-y-1.5">
              <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Сохранённые аккаунты
              </span>
              <div className="space-y-1 max-h-40 overflow-y-auto">
                {savedAccounts.map((acc) => (
                  <div
                    key={acc.id}
                    className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/20 px-2.5 py-1.5"
                  >
                    <button
                      type="button"
                      onClick={() => handleSelectSavedAccount(acc.id)}
                      className="flex items-center gap-2 min-w-0 flex-1 text-left cursor-pointer"
                    >
                      <span
                        className="size-6 rounded-full overflow-hidden flex items-center justify-center text-white font-semibold text-[11px] shrink-0"
                        style={{
                          backgroundColor: acc.avatar_url ? undefined : acc.avatar_color,
                        }}
                      >
                        {acc.avatar_url ? (
                          <img
                            src={acc.avatar_url}
                            alt={acc.display_name}
                            className="size-full object-cover"
                          />
                        ) : (
                          acc.display_name.slice(0, 1).toUpperCase()
                        )}
                      </span>
                      <div className="min-w-0">
                        <div className="text-xs font-medium text-foreground truncate leading-tight">
                          {acc.display_name}
                        </div>
                        <div className="text-[10px] font-mono text-muted-foreground truncate leading-tight">
                          @{acc.username}
                        </div>
                      </div>
                      {acc.requiresPassword && (
                        <span className="ml-auto shrink-0 text-[10px] font-medium text-amber-600 dark:text-amber-400">Нужен пароль</span>
                      )}
                    </button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => handleRemoveSavedAccount(acc.id)}
                      className="text-muted-foreground hover:text-destructive shrink-0"
                      title="Забыть аккаунт"
                    >
                      <X className="size-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}

          <Tabs value={unauthTab} onValueChange={setUnauthTab}>
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="login">Вход</TabsTrigger>
              <TabsTrigger value="register">Регистрация</TabsTrigger>
            </TabsList>

            <TabsContent value="login" className="pt-3">
              <form onSubmit={handleDirectLogin} className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="init-login-uname">Ваш @username</Label>
                  <Input
                    id="init-login-uname"
                    value={loginUsername}
                    onChange={(e) => setLoginUsername(e.target.value)}
                    placeholder="Введите @username"
                    className="font-mono"
                    aria-invalid={!!loginErrors.username}
                  />
                  {loginErrors.username && (
                    <p className="text-[11px] text-destructive">{loginErrors.username}</p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="init-login-pass">Пароль</Label>
                  <PasswordInput
                    id="init-login-pass"
                    value={loginPassword}
                    onChange={(e) => setLoginPassword(e.target.value)}
                    placeholder="Введите пароль"
                    aria-invalid={!!loginErrors.password}
                  />
                  {loginErrors.password && (
                    <p className="text-[11px] text-destructive">{loginErrors.password}</p>
                  )}
                </div>
                <Button type="submit" className="w-full" disabled={authSubmitting}>
                  Войти
                </Button>
              </form>
            </TabsContent>

            <TabsContent value="register" className="pt-3">
              <form onSubmit={handleDirectRegister} className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="init-reg-uname">Username</Label>
                  <Input
                    id="init-reg-uname"
                    value={regUsername}
                    onChange={(e) => setRegUsername(e.target.value)}
                    placeholder="username"
                    className="font-mono"
                    aria-invalid={!!regErrors.username}
                  />
                  {regErrors.username && (
                    <p className="text-[11px] text-destructive">{regErrors.username}</p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="init-reg-name">Отображаемое имя</Label>
                  <Input
                    id="init-reg-name"
                    value={regName}
                    onChange={(e) => setRegName(e.target.value)}
                    placeholder="Ваше имя"
                    aria-invalid={!!regErrors.display_name}
                  />
                  {regErrors.display_name && (
                    <p className="text-[11px] text-destructive">{regErrors.display_name}</p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="init-reg-pass">Пароль</Label>
                  <PasswordInput
                    id="init-reg-pass"
                    value={regPassword}
                    onChange={(e) => {
                      const val = e.target.value;
                      setRegPassword(val);
                      setRegErrors((prev) => ({
                        ...prev,
                        password:
                          val.length > 0 && val.length < 4
                            ? "Пароль должен содержать минимум 4 символа"
                            : "",
                        confirmPassword:
                          regConfirmPassword.length > 0 && val !== regConfirmPassword
                            ? "Пароли не совпадают"
                            : "",
                      }));
                    }}
                    placeholder="Минимум 4 символа"
                    aria-invalid={!!regErrors.password}
                  />
                  {regErrors.password && (
                    <p className="text-[11px] text-destructive">{regErrors.password}</p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="init-reg-confirm">Подтверждение пароля</Label>
                  <PasswordInput
                    id="init-reg-confirm"
                    value={regConfirmPassword}
                    onChange={(e) => {
                      const val = e.target.value;
                      setRegConfirmPassword(val);
                      setRegErrors((prev) => ({
                        ...prev,
                        confirmPassword:
                          val.length > 0 && regPassword !== val ? "Пароли не совпадают" : "",
                      }));
                    }}
                    placeholder="Повторите пароль"
                    aria-invalid={!!regErrors.confirmPassword}
                  />
                  {regErrors.confirmPassword && (
                    <p className="text-[11px] text-destructive">{regErrors.confirmPassword}</p>
                  )}
                </div>
                <div className="flex items-center justify-between py-1">
                  <span className="text-xs font-medium text-muted-foreground">Цвет аватара</span>
                  <div className="flex gap-1.5">
                    {AVATAR_COLORS.map((c) => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => setRegColor(c)}
                        className="size-5 rounded-full flex items-center justify-center cursor-pointer"
                        style={{ backgroundColor: c }}
                      >
                        {regColor === c && <Check className="size-3 text-white" />}
                      </button>
                    ))}
                  </div>
                </div>
                <Button type="submit" className="w-full" disabled={authSubmitting}>
                  Создать аккаунт
                </Button>
              </form>
            </TabsContent>
          </Tabs>
        <GroupInviteModal
          inviteCode={inviteCode}
          currentUser={currentUser}
          onJoined={handleJoinedGroupFromInvite}
          onOpenAuth={() => {
            setAuthUsername("");
            setAuthModalOpen(true);
          }}
          onClose={handleCloseInvite}
      />

        </div>
      </div>
    );
  }

  const acceptedGroups = groups.filter((g) => g.my_status === "accepted");

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col md:flex-row">
      <Toaster position="top-right" />

      {/* ЛЕВЫЙ САЙДБАР (Shadcn Sidebar) */}
      <aside className="w-full md:w-56 md:min-w-56 shrink-0 border-b md:border-b-0 md:border-r border-border bg-card/40 flex flex-col justify-between md:h-screen md:sticky md:top-0">
        <div className="p-3 space-y-5 overflow-y-auto">
          {/* Логотип и переключатель темы */}
          <div className="flex items-center justify-between px-1.5">
            <div className="flex items-center gap-2 font-semibold text-sm">
              <CalendarIcon className="size-4" />
              <span>Syncro</span>
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setDarkMode(!darkMode)}
              aria-label="Тема"
            >
              {darkMode ? <Sun className="size-4" /> : <Moon className="size-4" />}
            </Button>
          </div>

          {/* Навигация по группам */}
          <div className="space-y-1">
            <div className="flex items-center justify-between px-2 py-1">
              <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Группы
              </span>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => setCreateGroupOpen(true)}
                title="Создать группу"
              >
                <Plus className="size-3.5" />
              </Button>
            </div>

            <nav className="flex flex-col gap-1">
              {acceptedGroups.map((grp) => {
                const isAct = grp.id === activeGroup?.id;
                return (
                  <div key={grp.id} className="group/item flex items-center gap-0.5">
                    <Button
                      variant={isAct && !adminMode && !agentMode ? "secondary" : "ghost"}
                      size="sm"
                      onClick={() => {
                        if (adminMode) toggleAdminMode(false);
                        if (agentMode) toggleAgentMode(false);
                        setActiveGroupId(grp.id);
                        localStorage.setItem(STORAGE_GROUP_ID_KEY, String(grp.id));
                        setSelectedMemberIds([]);
                      }}
                      className="flex-1 justify-start text-xs font-medium min-w-0"
                    >
                      <span className="truncate">{grp.name}</span>
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => {
                        setActiveGroupId(grp.id);
                        localStorage.setItem(STORAGE_GROUP_ID_KEY, String(grp.id));
                        setGroupSettingsState({ open: true, tab: "settings" });
                      }}
                      className="opacity-0 group-hover/item:opacity-100 focus-visible:opacity-100 text-muted-foreground hover:text-foreground shrink-0"
                      title="Управление группой"
                    >
                      <Settings className="size-3.5" />
                    </Button>
                  </div>
                );
              })}

              <Button
                variant="ghost"
                size="sm"
                onClick={() => setCreateGroupOpen(true)}
                className="w-full justify-start text-xs text-muted-foreground"
              >
                <Plus className="size-3.5" />
                Новая группа
              </Button>
            </nav>
          </div>
        </div>

        {/* Нижний блок сайдбара: Дэшборд администратора, OpenAPI для агентов, Мой график и Личный кабинет */}
        <div className="p-3 border-t border-border space-y-1.5">
          {(currentUser.is_admin || currentUser.is_super_admin || currentUser.username.toLowerCase() === "qkeeper") && (
            <Button
              variant={adminMode ? "secondary" : "ghost"}
              size="sm"
              onClick={() => toggleAdminMode(!adminMode)}
              data-testid="toggle-admin-view"
              className="w-full justify-start text-xs font-medium"
            >
              {currentUser.is_super_admin || currentUser.username.toLowerCase() === "qkeeper" ? (
                <Crown className="size-3.5 text-amber-500" />
              ) : (
                <ShieldCheck className="size-3.5 text-amber-500" />
              )}
              Админ-панель
            </Button>
          )}

          <Button
            variant={agentMode ? "secondary" : "ghost"}
            size="sm"
            onClick={() => toggleAgentMode(!agentMode)}
            data-testid="toggle-agent-view"
            className="w-full justify-start text-xs font-medium"
          >
            <Bot className="size-3.5 text-primary" />
            OpenAPI / Агентам
          </Button>

          <Button
            variant="ghost"
            size="sm"
            onClick={() => setFeedbackModalOpen(true)}
            data-testid="toggle-feedback-view"
            className="w-full justify-start text-xs font-medium"
          >
            <MessageSquarePlus className="size-3.5 text-primary" />
            Обратная связь
          </Button>

          <Button
            variant="ghost"
            size="sm"
            onClick={() => setProfileModalOpen(true)}
            className="w-full justify-start text-xs font-medium"
          >
            <Layers className="size-3.5 text-primary" />
            Моё расписание
          </Button>

          <Button
            variant="ghost"
            onClick={() => setCabinetModalOpen(true)}
            className="w-full h-auto py-2 px-2 justify-between gap-2"
          >
            <div className="flex items-center gap-2.5 min-w-0 text-left">
              <span
                className="size-6 rounded-full overflow-hidden flex items-center justify-center text-white font-semibold text-[11px] shrink-0"
                style={{
                  backgroundColor: currentUser.avatar_url ? undefined : currentUser.avatar_color,
                }}
              >
                {currentUser.avatar_url ? (
                  <img
                    src={currentUser.avatar_url}
                    alt={currentUser.display_name}
                    className="size-full object-cover"
                  />
                ) : (
                  currentUser.display_name.slice(0, 1).toUpperCase()
                )}
              </span>
              <div className="min-w-0">
                <div className="text-xs font-medium text-foreground truncate leading-tight">
                  {currentUser.display_name}
                </div>
                <div className="text-[11px] font-mono text-muted-foreground truncate leading-tight">
                  @{currentUser.username}
                </div>
              </div>
            </div>
            <UserIcon className="size-3.5 text-muted-foreground shrink-0" />
          </Button>
        </div>
      </aside>

      {/* ОСНОВНАЯ ОБЛАСТЬ КОНТЕНТА */}
      <main className="flex-1 min-w-0 px-4 sm:px-6 py-6 space-y-4">
        {pendingInvites.length > 0 && (
          <div className="space-y-2">
            {pendingInvites.map((inv) => (
              <div
                key={inv.id}
                className="flex flex-wrap items-center justify-between gap-4 p-3 rounded-lg border border-border bg-card"
              >
                <div className="flex items-center gap-2.5 text-sm">
                  <Bell className="size-4 text-muted-foreground" />
                  <span>
                    Приглашение в группу <strong>{inv.name}</strong> от{" "}
                    <span className="font-mono text-xs text-muted-foreground">
                      @{inv.invited_by_username}
                    </span>
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleRespondInvite(inv.id, "decline")}
                    className="h-7 text-xs"
                  >
                    <X className="size-3.5" />
                    Отклонить
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => handleRespondInvite(inv.id, "accept")}
                    className="h-7 text-xs"
                  >
                    <Check className="size-3.5" />
                    Принять
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

        {adminMode && (currentUser.is_admin || currentUser.is_super_admin || currentUser.username.toLowerCase() === "qkeeper") ? (
          <AdminDashboardView
            currentUser={currentUser}
            onCloseAdminView={() => toggleAdminMode(false)}
            onRefreshGlobalData={() => fetchAllData(currentUser.id)}
          />
        ) : agentMode ? (
          <AgentApiView
            currentUser={currentUser}
            groups={groups}
            activeGroup={activeGroup}
            groupMembers={groupMembers}
            days={days}
            onSelectGroup={(groupId) => {
              setActiveGroupId(groupId);
              localStorage.setItem(STORAGE_GROUP_ID_KEY, String(groupId));
              setSelectedMemberIds([]);
            }}
            onSaveDayOverride={handleSaveDayOverride}
            onSaveUserProfile={handleSaveUserProfile}
            onRefreshData={() => fetchAllData(currentUser.id)}
            onCloseAgentView={() => toggleAgentMode(false)}
          />
        ) : (
          <>
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="min-w-0">
                  <h1 className="text-xl font-semibold tracking-tight truncate">
                    {activeGroup ? activeGroup.name : "Расписание"}
                  </h1>
                  {activeGroup?.description && (
                    <p className="text-xs text-muted-foreground truncate">
                      {activeGroup.description}
                    </p>
                  )}
                </div>

                {activeGroup && (
                  <div className="flex items-center gap-1.5 shrink-0">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setGroupSettingsState({ open: true, tab: "members" })}
                    >
                      <UserPlus className="size-3.5" />
                      Пригласить
                    </Button>
                    <Button
                      variant="outline"
                      size="icon-sm"
                      onClick={() => setGroupSettingsState({ open: true, tab: "settings" })}
                      title="Настройки группы"
                    >
                      <Settings className="size-3.5" />
                    </Button>
                  </div>
                )}
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setCabinetModalOpen(true)}
                  data-testid="toolbar-timezone-btn"
                  title="Часовой пояс таймлайна (нажмите, чтобы изменить в профиле)"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors cursor-pointer"
                >
                  <Globe className="size-3.5 text-primary" />
                  <span>{formatTimeZoneShort(currentUser.time_zone || DEFAULT_SCHEDULE_TIMEZONE)}</span>
                </button>

                <div className="inline-flex items-center rounded-lg border border-border bg-background p-0.5">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => {
                      setWeekStart((d) => addDays(d, -7));
                      setScrollCommand((prev) => ({ type: "week-nav", seq: prev.seq + 1 }));
                    }}
                  >
                    <ChevronLeft className="size-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      const nowTz = getNowInTimeZone(currentUser.time_zone || DEFAULT_SCHEDULE_TIMEZONE);
                      const [y, m, d] = nowTz.dateStr.split("-").map(Number);
                      const todayInTz = new Date(y, m - 1, d);
                      setWeekStart(startOfWeek(todayInTz, { weekStartsOn: 1 }));
                      setScrollCommand((prev) => ({ type: "today", seq: prev.seq + 1 }));
                    }}
                    className="px-2.5 text-xs font-medium"
                  >
                    Сегодня
                  </Button>
                  <span className="px-2.5 text-xs font-mono text-muted-foreground hidden md:inline">
                    {format(days[0], "d MMM", { locale: ru })} –{" "}
                    {format(days[days.length - 1], "d MMM", { locale: ru })}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => {
                      setWeekStart((d) => addDays(d, 7));
                      setScrollCommand((prev) => ({ type: "week-nav", seq: prev.seq + 1 }));
                    }}
                  >
                    <ChevronRight className="size-4" />
                  </Button>
                </div>

                <div className="inline-flex items-center rounded-lg bg-muted p-[3px] border border-border">
                  <button
                    type="button"
                    onClick={() => handleChangeDaysSpan(7)}
                    className={`px-2.5 py-1 rounded-md text-xs font-medium cursor-pointer ${
                      daysSpan === 7
                        ? "bg-background text-foreground shadow-xs dark:bg-input/30 dark:border-input"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    7 дн
                  </button>
                  <button
                    type="button"
                    onClick={() => handleChangeDaysSpan(14)}
                    className={`px-2.5 py-1 rounded-md text-xs font-medium cursor-pointer ${
                      daysSpan === 14
                        ? "bg-background text-foreground shadow-xs dark:bg-input/30 dark:border-input"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    14 дн
                  </button>
                </div>
              </div>
            </div>

            <OccupancyCalendarGrid
              days={days}
              members={groupMembers}
              currentUser={currentUser}
              selectedMemberIds={selectedMemberIds}
              onToggleMemberFilter={handleToggleMemberFilter}
              onSelectCombinationPreset={(ids) => setSelectedMemberIds(ids)}
              onReorderMembers={handleReorderMembers}
              onCellClick={(user, date, groupId) => {
                if (user.id === currentUser.id) {
                  setOverrideTarget({ user, date, groupId, open: true });
                }
              }}
              onOpenMySchedule={() => setProfileModalOpen(true)}
              scrollCommand={scrollCommand}
              onScrollDayOffsetChange={(offset) => {
                currentTimelineDayOffsetRef.current = offset;
              }}
            />
          </>
        )}
      </main>

      <TimelineGroupsModal
        open={profileModalOpen}
        onOpenChange={setProfileModalOpen}
        user={currentUser}
        onSaveUser={handleSaveUserProfile}
      />

      <DayOverrideModal
        open={overrideTarget.open}
        onOpenChange={(open) => setOverrideTarget((p) => ({ ...p, open }))}
        user={currentUser}
        date={overrideTarget.date}
        initialGroupId={overrideTarget.groupId}
        onSaveOverride={handleSaveDayOverride}
      />

      <CreateGroupModal
        open={createGroupOpen}
        onOpenChange={setCreateGroupOpen}
        currentUser={currentUser}
        onGroupCreated={async (newGroupId) => {
          setActiveGroupId(newGroupId);
          localStorage.setItem(STORAGE_GROUP_ID_KEY, String(newGroupId));
          setSelectedMemberIds([]);
          await fetchAllData(currentUser.id, newGroupId);
        }}
      />

      <GroupSettingsModal
        open={groupSettingsState.open}
        onOpenChange={(open) => setGroupSettingsState((prev) => ({ ...prev, open }))}
        group={activeGroup}
        currentUser={currentUser}
        defaultTab={groupSettingsState.tab}
        onGroupUpdated={() => fetchAllData(currentUser.id)}
        onGroupDeletedOrLeft={async () => {
          localStorage.removeItem(STORAGE_GROUP_ID_KEY);
          setSelectedMemberIds([]);
          await fetchAllData(currentUser.id);
        }}
      />

      <ProfileCabinetModal
        open={cabinetModalOpen}
        onOpenChange={setCabinetModalOpen}
        currentUser={currentUser}
        onUpdateProfile={handleSaveUserProfile}
        savedAccounts={savedAccounts}
        onSelectSavedAccount={handleSelectSavedAccount}
        onRemoveSavedAccount={handleRemoveSavedAccount}
        onOpenAddAccount={() => { setAuthUsername(""); setAuthModalOpen(true); }}
        onLogout={handleLogout}
      />

      <GroupInviteModal
        inviteCode={inviteCode}
        currentUser={currentUser}
        onJoined={handleJoinedGroupFromInvite}
        onOpenAuth={() => {
          setAuthUsername("");
          setAuthModalOpen(true);
        }}
        onClose={handleCloseInvite}
      />

      <FeedbackModal
        open={feedbackModalOpen}
        onOpenChange={setFeedbackModalOpen}
        currentUser={currentUser}
      />

      <AuthModal
        open={authModalOpen}
        onOpenChange={setAuthModalOpen}
        initialUsername={authUsername}
        onSelectUser={async (u) => {
          setAuthModalOpen(false);
          setCabinetModalOpen(false);
          localStorage.setItem(STORAGE_USER_ID_KEY, String(u.id));
          setSelectedMemberIds([]);
          await fetchAllData(u.id);
        }}
        onUserRegistered={async (u) => {
          setAuthModalOpen(false);
          setCabinetModalOpen(false);
          localStorage.setItem(STORAGE_USER_ID_KEY, String(u.id));
          setSelectedMemberIds([]);
          await fetchAllData(u.id);
        }}
      />
    </div>
  );
}
export default App;
