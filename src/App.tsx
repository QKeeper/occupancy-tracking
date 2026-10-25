import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { User, Group, DayOverride } from "@/types";
import { OccupancyCalendarGrid } from "@/components/OccupancyCalendarGrid";
import { ScheduleProfileModal } from "@/components/ScheduleProfileModal";
import { DayOverrideModal } from "@/components/DayOverrideModal";
import { CreateGroupModal, GroupSettingsModal } from "@/components/GroupModals";
import { AgentApiView } from "@/components/AgentApiView";
import {
  AuthModal,
  ProfileCabinetModal,
  AVATAR_COLORS,
  SavedAccount,
} from "@/components/AuthModal";
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
    const compact = accounts.map(({ id, username, display_name, avatar_color }) => ({
      id,
      username,
      display_name,
      avatar_color,
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
      return Array.isArray(parsed) ? parsed : [];
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

  // Unauthenticated screen form states
  const [loginUsername, setLoginUsername] = useState("");
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

  const toggleAgentMode = (next: boolean) => {
    setAgentMode(next);
    const url = new URL(window.location.href);
    if (next) {
      url.searchParams.set("agent", "1");
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
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [overrideTarget, setOverrideTarget] = useState<{
    user: User | null;
    date: Date | null;
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
      const savedUserIdStr = localStorage.getItem(STORAGE_USER_ID_KEY);
      const savedUserId = savedUserIdStr ? parseInt(savedUserIdStr, 10) : undefined;
      const targetUserId = preferredUserId ?? currentUserRef.current?.id ?? savedUserId;

      if (!targetUserId) {
        setCurrentUser(null);
        setGroups([]);
        setLoading(false);
        return;
      }

      const [uRes, gRes] = await Promise.all([
        fetch(`/api/users/${targetUserId}`),
        fetch(`/api/groups?userId=${targetUserId}`),
      ]);

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
        gRes.json(),
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

  // Hydrate avatar_url and latest profile info for saved accounts in a single lightweight batch request
  useEffect(() => {
    const missingIds = savedAccounts
      .filter((acc) => acc.avatar_url === undefined)
      .map((acc) => acc.id);
    if (missingIds.length === 0) return;

    let cancelled = false;
    fetch(`/api/users-mini?ids=${missingIds.join(",")}`)
      .then((res) => (res.ok ? res.json() : []))
      .then((rows: SavedAccount[]) => {
        if (cancelled || !Array.isArray(rows) || rows.length === 0) return;
        const map = new Map(rows.map((r) => [r.id, r]));
        setSavedAccounts((prev) => {
          const next = prev.map((acc) => {
            const fresh = map.get(acc.id);
            return fresh
              ? {
                  id: fresh.id,
                  username: fresh.username,
                  display_name: fresh.display_name,
                  avatar_color: fresh.avatar_color,
                  avatar_url: fresh.avatar_url ?? null,
                }
              : acc;
          });
          persistSavedAccounts(next);
          return next;
        });
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [savedAccounts.length]);

  // Real-time Server-Sent Events (SSE) subscription
  useEffect(() => {
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
  }, [fetchAllData]);

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
      .map((m) => ({
        id: m.user_id,
        username: m.username,
        display_name: m.display_name,
        role_title: m.role_title,
        avatar_color: m.avatar_color,
        avatar_url: m.avatar_url,
        banner_url: m.banner_url,
        timeline_style: m.timeline_style,
        schedule_config: m.schedule_config,
        overrides: m.overrides,
      }));

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
      }).catch(() => {});
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
      body: JSON.stringify(updated),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Не удалось обновить профиль");
    await fetchAllData(currentUser.id);
  };

  const handleSaveDayOverride = async (
    userId: number,
    dateStr: string,
    override: DayOverride | null
  ) => {
    if (!currentUser || userId !== currentUser.id) {
      toast.error("Редактировать можно только свой собственный график");
      return;
    }

    const nextOverrides = { ...(currentUser.overrides || {}) };
    if (override === null) {
      delete nextOverrides[dateStr];
    } else {
      nextOverrides[dateStr] = override;
    }

    const res = await fetch(`/api/users/${currentUser.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ overrides: nextOverrides }),
    });
    if (!res.ok) throw new Error("Ошибка сохранения дня");
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
      localStorage.setItem(STORAGE_USER_ID_KEY, String(data.id));
      toast.success(`Аккаунт @${data.username} создан`);
      await fetchAllData(data.id);
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setAuthSubmitting(false);
    }
  };

  const handleLogout = () => {
    localStorage.removeItem(STORAGE_USER_ID_KEY);
    localStorage.removeItem(STORAGE_GROUP_ID_KEY);
    setCurrentUser(null);
    setGroups([]);
    setActiveGroupId(null);
    setSelectedMemberIds([]);
  };

  const handleSelectSavedAccount = async (accountId: number) => {
    localStorage.setItem(STORAGE_USER_ID_KEY, String(accountId));
    setSelectedMemberIds([]);
    await fetchAllData(accountId);
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

          <Tabs defaultValue="login">
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
                      variant={isAct ? "secondary" : "ghost"}
                      size="sm"
                      onClick={() => {
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

        {/* Нижний блок сайдбара: OpenAPI для агентов, Мой график и Личный кабинет пользователя */}
        <div className="p-3 border-t border-border space-y-1.5">
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
            variant="outline"
            size="sm"
            onClick={() => setProfileModalOpen(true)}
            className="w-full justify-start text-xs"
          >
            <Settings2 className="size-3.5" />
            Мой график работы
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

        {agentMode ? (
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
                      setWeekStart(startOfWeek(new Date(), { weekStartsOn: 1 }));
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
              onCellClick={(user, date) => {
                if (user.id === currentUser.id) {
                  setOverrideTarget({ user, date, open: true });
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

      <ScheduleProfileModal
        open={profileModalOpen}
        onOpenChange={setProfileModalOpen}
        user={currentUser}
        onSaveUser={handleSaveUserProfile}
      />

      <DayOverrideModal
        open={overrideTarget.open}
        onOpenChange={(open) => setOverrideTarget((p) => ({ ...p, open }))}
        user={overrideTarget.user}
        date={overrideTarget.date}
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
        onOpenAddAccount={() => setAuthModalOpen(true)}
        onLogout={handleLogout}
      />

      <AuthModal
        open={authModalOpen}
        onOpenChange={setAuthModalOpen}
        onSelectUser={(u) => {
          localStorage.setItem(STORAGE_USER_ID_KEY, String(u.id));
          setSelectedMemberIds([]);
          fetchAllData(u.id);
        }}
        onUserRegistered={async (u) => {
          localStorage.setItem(STORAGE_USER_ID_KEY, String(u.id));
          setSelectedMemberIds([]);
          await fetchAllData(u.id);
        }}
      />
    </div>
  );
}
export default App;
