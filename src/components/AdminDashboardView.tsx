import React, { useState, useEffect, useMemo, useCallback } from "react";
import { User } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { format, parseISO } from "date-fns";
import { ru } from "date-fns/locale/ru";
import { toast } from "sonner";
import {
  ShieldCheck,
  Crown,
  Users,
  Database,
  Image as ImageIcon,
  TrendingUp,
  TrendingDown,
  Minus,
  RefreshCw,
  ArrowLeft,
  Trash2,
  Search,
  UserPlus,
  UserMinus,
  HardDrive,
  Activity,
  FolderGit2,
  CalendarCheck2,
  ExternalLink,
  CheckCircle2,
  AlertTriangle,
  Sparkles,
} from "lucide-react";

interface AdminDashboardViewProps {
  currentUser: User;
  onCloseAdminView: () => void;
  onRefreshGlobalData: () => Promise<void>;
}

interface DailyPoint {
  date: string;
  dau: number;
  requests: number;
  new_users: number;
  new_groups: number;
}

interface TableStat {
  tableName: string;
  totalBytes: number;
  dataBytes: number;
  indexToastBytes: number;
  rowEstimate: number;
}

interface MediaFileStat {
  name: string;
  url: string;
  kind: "avatar" | "banner" | "icon" | "other";
  ext: string;
  sizeBytes: number;
  isReferenced?: boolean;
  mtime: string;
}

interface AdminUserRow {
  id: number;
  username: string;
  display_name: string;
  avatar_color: string;
  avatar_url?: string | null;
  banner_url?: string | null;
  time_zone: string;
  schedule_mode: string;
  created_at: string;
  is_admin: boolean;
  is_super_admin: boolean;
  groups_count: number;
  overrides_count: number;
  last_seen_at?: string | null;
  total_requests: number;
  active_days_count: number;
}

interface AdminGroupRow {
  id: number;
  name: string;
  description: string;
  owner_id: number;
  created_at: string;
  owner_username?: string;
  owner_display_name?: string;
  accepted_members_count: number;
  pending_members_count: number;
}

interface AdminStatsPayload {
  viewer: {
    id: number;
    username: string;
    is_admin: boolean;
    is_super_admin: boolean;
  };
  superAdminUsername: string;
  generatedAt: string;
  periodDays: number;
  kpis: {
    totalUsers: number;
    totalGroups: number;
    totalOverrides: number;
    totalIntervals: number;
    activeSessions: number;
    dauToday: number;
    dauYesterday: number;
    wauCurrent: number;
    wauPrev: number;
    mauCurrent: number;
    newUsers7d: number;
    newUsersPrev7d: number;
  };
  scheduleModes: { mode: string; count: number }[];
  dailySeries: DailyPoint[];
  database: {
    dbName: string;
    schemaName: string;
    totalDbBytes: number;
    schemaTablesBytes: number;
    tables: TableStat[];
  };
  media: {
    totalFiles: number;
    totalBytes: number;
    referencedFilesCount: number;
    referencedBytes: number;
    orphanedFilesCount: number;
    orphanedBytes: number;
    byKind: {
      avatar: { count: number; bytes: number };
      banner: { count: number; bytes: number };
      icon: { count: number; bytes: number };
      other: { count: number; bytes: number };
    };
    byExtension: Record<string, { count: number; bytes: number }>;
    orphanedFiles: MediaFileStat[];
    largestFiles: MediaFileStat[];
  };
  users: AdminUserRow[];
  groups: AdminGroupRow[];
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 Б";
  const units = ["Б", "КБ", "МБ", "ГБ", "ТБ"];
  let idx = 0;
  let val = bytes;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx++;
  }
  return `${val >= 100 || idx === 0 ? Math.round(val) : val.toFixed(val >= 10 ? 1 : 2)} ${units[idx]}`;
}

function computeDeltaPercent(current: number, prev: number): { label: string; direction: "up" | "down" | "flat" } {
  if (prev === 0 && current === 0) return { label: "0%", direction: "flat" };
  if (prev === 0 && current > 0) return { label: `+100%`, direction: "up" };
  const diff = ((current - prev) / prev) * 100;
  const rounded = Math.round(diff);
  if (rounded > 0) return { label: `+${rounded}%`, direction: "up" };
  if (rounded < 0) return { label: `${rounded}%`, direction: "down" };
  return { label: "0%", direction: "flat" };
}

const KIND_LABELS: Record<string, { label: string; color: string }> = {
  avatar: { label: "Аватарки", color: "#3b82f6" },
  banner: { label: "Баннеры", color: "#8b5cf6" },
  icon: { label: "Иконки паттернов", color: "#10b981" },
  other: { label: "Прочее", color: "#71717a" },
};

const MODE_LABELS: Record<string, { label: string; color: string }> = {
  fixed_weekly: { label: "Фиксированный (5/2)", color: "#3b82f6" },
  shift_cycle: { label: "Сменный (2/2 и др.)", color: "#f59e0b" },
  manual: { label: "Ручной режим", color: "#10b981" },
};

export function AdminDashboardView({
  currentUser,
  onCloseAdminView,
  onRefreshGlobalData,
}: AdminDashboardViewProps) {
  const [periodDays, setPeriodDays] = useState<14 | 30 | 90>(30);
  const [stats, setStats] = useState<AdminStatsPayload | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Admin management state
  const [newAdminInput, setNewAdminInput] = useState("");
  const [adminMutatingId, setAdminMutatingId] = useState<number | null>(null);

  // Cleanup state
  const [cleaningMedia, setCleaningMedia] = useState(false);

  // Search/filter states
  const [userSearch, setUserSearch] = useState("");
  const [userRoleFilter, setUserRoleFilter] = useState<"all" | "admins">("all");
  const [groupSearch, setGroupSearch] = useState("");

  // Interactive chart hover state
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  const loadStats = useCallback(
    async (days = periodDays, silent = false) => {
      if (!silent) setLoading(true);
      else setRefreshing(true);
      setError(null);
      try {
        const res = await fetch(`/api/admin/stats?days=${days}`, { cache: "no-store" });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Ошибка загрузки статистики администратора");
        setStats(data);
      } catch (err: any) {
        setError(err.message || "Не удалось загрузить дэшборд");
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [periodDays]
  );

  useEffect(() => {
    void loadStats(periodDays);
  }, [periodDays, loadStats]);

  const isSuperAdmin = Boolean(
    stats?.viewer?.is_super_admin ||
      currentUser.is_super_admin ||
      currentUser.username.toLowerCase() === "qkeeper"
  );

  const handleToggleAdmin = async (targetUser: AdminUserRow, nextIsAdmin: boolean) => {
    if (!isSuperAdmin) {
      toast.error("Только главный администратор (@qkeeper) может управлять админами");
      return;
    }
    setAdminMutatingId(targetUser.id);
    try {
      const res = await fetch("/api/admin/admins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: targetUser.id, isAdmin: nextIsAdmin }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Ошибка изменения прав");
      toast.success(
        nextIsAdmin
          ? `Пользователь @${targetUser.username} назначен администратором`
          : `Права администратора сняты с @${targetUser.username}`
      );
      await loadStats(periodDays, true);
      await onRefreshGlobalData();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setAdminMutatingId(null);
    }
  };

  const handleGrantByUsername = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newAdminInput.trim()) return;
    if (!isSuperAdmin) {
      toast.error("Только главный администратор (@qkeeper) может назначать админов");
      return;
    }
    setAdminMutatingId(-1);
    try {
      const res = await fetch("/api/admin/admins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: newAdminInput.trim(), isAdmin: true }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Ошибка назначения администратора");
      toast.success(`Пользователь @${data.user.username} назначен администратором`);
      setNewAdminInput("");
      await loadStats(periodDays, true);
      await onRefreshGlobalData();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setAdminMutatingId(null);
    }
  };

  const handleCleanupOrphanedMedia = async () => {
    if (!stats || stats.media.orphanedFilesCount === 0) return;
    setCleaningMedia(true);
    try {
      const res = await fetch("/api/admin/media/cleanup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Ошибка очистки файлов");
      toast.success(
        `Удалено файлов: ${data.deletedCount} (освобождено ${formatBytes(data.freedBytes)})`
      );
      await loadStats(periodDays, true);
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setCleaningMedia(false);
    }
  };

  const filteredUsers = useMemo(() => {
    if (!stats) return [];
    const q = userSearch.trim().toLowerCase().replace(/^@/, "");
    return stats.users.filter((u) => {
      if (userRoleFilter === "admins" && !u.is_admin) return false;
      if (!q) return true;
      return (
        u.username.toLowerCase().includes(q) ||
        u.display_name.toLowerCase().includes(q) ||
        String(u.id) === q
      );
    });
  }, [stats, userSearch, userRoleFilter]);

  const filteredGroups = useMemo(() => {
    if (!stats) return [];
    const q = groupSearch.trim().toLowerCase();
    if (!q) return stats.groups;
    return stats.groups.filter(
      (g) =>
        g.name.toLowerCase().includes(q) ||
        (g.description || "").toLowerCase().includes(q) ||
        (g.owner_username || "").toLowerCase().includes(q)
    );
  }, [stats, groupSearch]);

  const adminsList = useMemo(() => {
    if (!stats) return [];
    return stats.users.filter((u) => u.is_admin);
  }, [stats]);

  if (loading && !stats) {
    return (
      <div className="rounded-xl border border-border bg-card p-8 flex flex-col items-center justify-center gap-3 min-h-[420px]">
        <RefreshCw className="size-6 animate-spin text-primary" />
        <p className="text-sm text-muted-foreground">Загрузка аналитики и метрик сервера...</p>
      </div>
    );
  }

  if (error || !stats) {
    return (
      <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-6 space-y-4">
        <div className="flex items-center gap-2.5 text-destructive font-semibold">
          <AlertTriangle className="size-5" />
          <span>Не удалось открыть панель администратора</span>
        </div>
        <p className="text-xs text-muted-foreground">{error || "Нет данных"}</p>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => loadStats(periodDays)}>
            Повторить
          </Button>
          <Button size="sm" onClick={onCloseAdminView}>
            Вернуться к календарю
          </Button>
        </div>
      </div>
    );
  }

  const dauTrend = computeDeltaPercent(stats.kpis.dauToday, stats.kpis.dauYesterday);
  const wauTrend = computeDeltaPercent(stats.kpis.wauCurrent, stats.kpis.wauPrev);
  const regTrend = computeDeltaPercent(stats.kpis.newUsers7d, stats.kpis.newUsersPrev7d);
  const stickinessRatio =
    stats.kpis.mauCurrent > 0
      ? Math.round((stats.kpis.dauToday / stats.kpis.mauCurrent) * 100)
      : 0;

  // Chart calculations for DAU & Registrations
  const series = stats.dailySeries;
  const maxDau = Math.max(1, ...series.map((d) => d.dau), ...series.map((d) => d.new_users));
  const chartW = 760;
  const chartH = 210;
  const padL = 32;
  const padR = 14;
  const padT = 16;
  const padB = 28;
  const innerW = chartW - padL - padR;
  const innerH = chartH - padT - padB;

  const getX = (idx: number) =>
    series.length <= 1 ? padL + innerW / 2 : padL + (idx / (series.length - 1)) * innerW;
  const getY = (val: number) => padT + innerH - (Math.min(val, maxDau) / maxDau) * innerH;

  const dauLinePoints = series.map((pt, idx) => `${getX(idx)},${getY(pt.dau)}`).join(" ");
  const dauAreaPoints =
    series.length > 0
      ? `${getX(0)},${padT + innerH} ${dauLinePoints} ${getX(series.length - 1)},${padT + innerH}`
      : "";

  const activePoint = hoveredIdx !== null && series[hoveredIdx] ? series[hoveredIdx] : series[series.length - 1];

  return (
    <div
      id="admin-dashboard-view"
      data-testid="admin-dashboard-view"
      className="space-y-6 pb-8"
    >
      {/* Шапка дэшборда администратора */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card p-4 shadow-xs">
        <div className="flex items-start gap-3">
          <div className="rounded-lg bg-amber-500/15 p-2.5 text-amber-500 border border-amber-500/25">
            <ShieldCheck className="size-5" />
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-base sm:text-lg font-semibold tracking-tight">
                Дэшборд администратора
              </h1>
              {isSuperAdmin ? (
                <Badge className="bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30 hover:bg-amber-500/20 gap-1">
                  <Crown className="size-3" />
                  Главный админ (@{stats.superAdminUsername})
                </Badge>
              ) : (
                <Badge variant="secondary" className="gap-1">
                  <ShieldCheck className="size-3 text-primary" />
                  Администратор
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              Мониторинг уникальных пользователей (DAU/WAU/MAU), вес базы PostgreSQL, ревизия картинок в{" "}
              <code className="font-mono text-[11px] bg-muted px-1 py-0.5 rounded">/uploads</code> и управление правами доступа.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Переключатель периода графиков */}
          <div className="inline-flex items-center rounded-lg bg-muted p-[3px] border border-border">
            {([14, 30, 90] as const).map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setPeriodDays(d)}
                data-testid={`admin-period-${d}`}
                className={`px-2.5 py-1 rounded-md text-xs font-medium cursor-pointer transition-colors ${
                  periodDays === d
                    ? "bg-background text-foreground shadow-xs"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {d} дн
              </button>
            ))}
          </div>

          <Button
            variant="outline"
            size="sm"
            onClick={() => loadStats(periodDays, true)}
            disabled={refreshing}
            data-testid="admin-refresh-btn"
          >
            <RefreshCw className={`size-3.5 ${refreshing ? "animate-spin" : ""}`} />
            Обновить
          </Button>

          <Button
            variant="default"
            size="sm"
            onClick={onCloseAdminView}
            data-testid="admin-close-btn"
          >
            <ArrowLeft className="size-3.5" />
            К расписанию
          </Button>
        </div>
      </div>

      {/* ВЕРХНИЕ КАРТОЧКИ МЕТРИК (KPI + Тенденции) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
        {/* Карточка 1: Уникальные пользователи в день (DAU) */}
        <div
          data-testid="kpi-card-dau"
          className="rounded-xl border border-border bg-card p-4 space-y-2 shadow-2xs"
        >
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span className="font-medium">Уникальные за сегодня (DAU)</span>
            <Activity className="size-4 text-emerald-500" />
          </div>
          <div className="flex items-baseline justify-between gap-2">
            <div className="text-2xl font-bold tracking-tight font-mono">
              {stats.kpis.dauToday}
            </div>
            <TrendPill trend={dauTrend} suffix="к вчера" />
          </div>
          <div className="flex items-center justify-between text-[11px] text-muted-foreground pt-1 border-t border-border/60">
            <span>WAU (7 дн): <strong className="text-foreground font-mono">{stats.kpis.wauCurrent}</strong></span>
            <span>MAU (30 дн): <strong className="text-foreground font-mono">{stats.kpis.mauCurrent}</strong></span>
            <span>Stickiness: <strong className="text-foreground font-mono">{stickinessRatio}%</strong></span>
          </div>
        </div>

        {/* Карточка 2: Всего пользователей и динамика регистраций */}
        <div
          data-testid="kpi-card-users"
          className="rounded-xl border border-border bg-card p-4 space-y-2 shadow-2xs"
        >
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span className="font-medium">Пользователи и группы</span>
            <Users className="size-4 text-blue-500" />
          </div>
          <div className="flex items-baseline justify-between gap-2">
            <div className="text-2xl font-bold tracking-tight font-mono">
              {stats.kpis.totalUsers}
            </div>
            <TrendPill trend={regTrend} suffix={`+${stats.kpis.newUsers7d} за 7д`} />
          </div>
          <div className="flex items-center justify-between text-[11px] text-muted-foreground pt-1 border-t border-border/60">
            <span>Групп: <strong className="text-foreground font-mono">{stats.kpis.totalGroups}</strong></span>
            <span>Правок: <strong className="text-foreground font-mono">{stats.kpis.totalOverrides}</strong></span>
            <span>Сессий: <strong className="text-foreground font-mono">{stats.kpis.activeSessions}</strong></span>
          </div>
        </div>

        {/* Карточка 3: Вес базы данных PostgreSQL */}
        <div
          data-testid="kpi-card-db-size"
          className="rounded-xl border border-border bg-card p-4 space-y-2 shadow-2xs"
        >
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span className="font-medium">Вес базы данных (PostgreSQL)</span>
            <Database className="size-4 text-violet-500" />
          </div>
          <div className="flex items-baseline justify-between gap-2">
            <div className="text-2xl font-bold tracking-tight font-mono">
              {formatBytes(stats.database.totalDbBytes)}
            </div>
            <span className="text-[11px] font-mono text-muted-foreground">
              таблицы: {formatBytes(stats.database.schemaTablesBytes)}
            </span>
          </div>
          <div className="flex items-center justify-between text-[11px] text-muted-foreground pt-1 border-t border-border/60">
            <span className="truncate">БД: <strong className="text-foreground font-mono">{stats.database.dbName}</strong></span>
            <span>Таблиц: <strong className="text-foreground font-mono">{stats.database.tables.length}</strong></span>
          </div>
        </div>

        {/* Карточка 4: Вес картинок в загрузках (/uploads) */}
        <div
          data-testid="kpi-card-uploads-size"
          className="rounded-xl border border-border bg-card p-4 space-y-2 shadow-2xs"
        >
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span className="font-medium">Вес картинок в загрузках</span>
            <ImageIcon className="size-4 text-pink-500" />
          </div>
          <div className="flex items-baseline justify-between gap-2">
            <div className="text-2xl font-bold tracking-tight font-mono">
              {formatBytes(stats.media.totalBytes)}
            </div>
            <span className="text-[11px] font-mono text-muted-foreground">
              {stats.media.totalFiles} файл(ов)
            </span>
          </div>
          <div className="flex items-center justify-between text-[11px] text-muted-foreground pt-1 border-t border-border/60">
            <span>Активных: <strong className="text-emerald-600 dark:text-emerald-400 font-mono">{formatBytes(stats.media.referencedBytes)}</strong></span>
            <span>Сирот: <strong className={`${stats.media.orphanedFilesCount > 0 ? "text-amber-500" : "text-foreground"} font-mono`}>{stats.media.orphanedFilesCount} ({formatBytes(stats.media.orphanedBytes)})</strong></span>
          </div>
        </div>
      </div>

      {/* ВКЛАДКИ РАЗДЕЛОВ АДМИНКИ */}
      <Tabs defaultValue="overview" className="space-y-4">
        <TabsList className="flex flex-wrap h-auto gap-1">
          <TabsTrigger value="overview" data-testid="admin-tab-overview">
            <TrendingUp className="size-3.5 mr-1.5" />
            Графики и тенденции
          </TabsTrigger>
          <TabsTrigger value="storage" data-testid="admin-tab-storage">
            <HardDrive className="size-3.5 mr-1.5" />
            База данных и картинки ({formatBytes(stats.media.totalBytes)})
          </TabsTrigger>
          <TabsTrigger value="admins" data-testid="admin-tab-admins">
            <Crown className="size-3.5 mr-1.5 text-amber-500" />
            Администраторы ({adminsList.length})
          </TabsTrigger>
          <TabsTrigger value="users" data-testid="admin-tab-users">
            <Users className="size-3.5 mr-1.5" />
            Пользователи ({stats.users.length}) и Группы ({stats.groups.length})
          </TabsTrigger>
        </TabsList>

        {/* =================================================================== */}
        {/* ВКЛАДКА 1: ГРАФИКИ И ТЕНДЕНЦИИ                                     */}
        {/* =================================================================== */}
        <TabsContent value="overview" className="space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {/* Главный график DAU + Новые регистрации */}
            <div className="lg:col-span-2 rounded-xl border border-border bg-card p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="text-sm font-semibold">
                    Динамика уникальных пользователей в день (DAU) и новых регистраций
                  </h2>
                  <p className="text-xs text-muted-foreground">
                    Наведите курсор на график для просмотра точных показателей за выбранный день ({periodDays} дн.)
                  </p>
                </div>

                {activePoint && (
                  <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/30 px-3 py-1.5 text-xs font-mono">
                    <span className="font-semibold text-foreground">{activePoint.date}</span>
                    <span className="text-emerald-600 dark:text-emerald-400">
                      DAU: <strong>{activePoint.dau}</strong>
                    </span>
                    <span className="text-blue-600 dark:text-blue-400">
                      Новых: <strong>+{activePoint.new_users}</strong>
                    </span>
                    <span className="text-muted-foreground hidden sm:inline">
                      Запросов: {activePoint.requests}
                    </span>
                  </div>
                )}
              </div>

              {/* SVG График */}
              <div className="relative w-full overflow-x-auto pt-1">
                <svg
                  viewBox={`0 0 ${chartW} ${chartH}`}
                  className="w-full h-52 select-none overflow-visible"
                  onMouseLeave={() => setHoveredIdx(null)}
                >
                  <defs>
                    <linearGradient id="dauAreaGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#10b981" stopOpacity="0.32" />
                      <stop offset="100%" stopColor="#10b981" stopOpacity="0.0" />
                    </linearGradient>
                  </defs>

                  {/* Горизонтальные линии сетки */}
                  {[0, 0.25, 0.5, 0.75, 1].map((ratio, i) => {
                    const y = padT + innerH * (1 - ratio);
                    const val = Math.round(maxDau * ratio);
                    return (
                      <g key={i}>
                        <line
                          x1={padL}
                          y1={y}
                          x2={chartW - padR}
                          y2={y}
                          stroke="currentColor"
                          className="text-border"
                          strokeDasharray={ratio === 0 ? undefined : "3 3"}
                          strokeWidth="1"
                        />
                        <text
                          x={padL - 6}
                          y={y + 3}
                          textAnchor="end"
                          className="fill-muted-foreground text-[10px] font-mono"
                        >
                          {val}
                        </text>
                      </g>
                    );
                  })}

                  {/* Заливка под кривой DAU */}
                  {dauAreaPoints && <polygon points={dauAreaPoints} fill="url(#dauAreaGrad)" />}

                  {/* Столбики новых регистраций */}
                  {series.map((pt, idx) => {
                    if (pt.new_users <= 0) return null;
                    const x = getX(idx);
                    const y = getY(pt.new_users);
                    const barW = Math.max(4, Math.min(14, innerW / series.length - 3));
                    return (
                      <rect
                        key={`reg-${pt.date}`}
                        x={x - barW / 2}
                        y={y}
                        width={barW}
                        height={padT + innerH - y}
                        rx={2}
                        fill="#3b82f6"
                        opacity={0.45}
                      />
                    );
                  })}

                  {/* Линия DAU */}
                  {dauLinePoints && (
                    <polyline
                      fill="none"
                      stroke="#10b981"
                      strokeWidth="2.25"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      points={dauLinePoints}
                    />
                  )}

                  {/* Точки и интерактивные зоны */}
                  {series.map((pt, idx) => {
                    const x = getX(idx);
                    const y = getY(pt.dau);
                    const isHovered = hoveredIdx === idx;
                    const showLabel =
                      idx === 0 ||
                      idx === series.length - 1 ||
                      idx % Math.max(1, Math.floor(series.length / 6)) === 0;

                    return (
                      <g key={pt.date}>
                        {isHovered && (
                          <line
                            x1={x}
                            y1={padT}
                            x2={x}
                            y2={padT + innerH}
                            stroke="#10b981"
                            strokeWidth="1"
                            strokeDasharray="2 2"
                          />
                        )}
                        <circle
                          cx={x}
                          cy={y}
                          r={isHovered ? 4.5 : 2.5}
                          fill="#10b981"
                          className="transition-all"
                        />
                        {showLabel && (
                          <text
                            x={x}
                            y={chartH - 6}
                            textAnchor="middle"
                            className="fill-muted-foreground text-[10px] font-mono"
                          >
                            {pt.date.slice(5)}
                          </text>
                        )}
                        {/* Невидимая полоса для удобного ховера */}
                        <rect
                          x={x - innerW / Math.max(1, series.length) / 2}
                          y={padT}
                          width={innerW / Math.max(1, series.length)}
                          height={innerH}
                          fill="transparent"
                          className="cursor-crosshair"
                          onMouseEnter={() => setHoveredIdx(idx)}
                        />
                      </g>
                    );
                  })}
                </svg>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground pt-1 border-t border-border/60">
                <div className="flex items-center gap-4">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="size-2.5 rounded-full bg-emerald-500 inline-block" />
                    Уникальные пользователи (DAU)
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="size-2.5 rounded-xs bg-blue-500/60 inline-block" />
                    Новые регистрации в день
                  </span>
                </div>
                <span className="font-mono text-[11px]">
                  Пик за период: {Math.max(0, ...series.map((s) => s.dau))} юзеров/день
                </span>
              </div>
            </div>

            {/* Правая колонка: Сводка тенденций и распределение режимов расписания */}
            <div className="space-y-4">
              {/* Блок тенденций активности */}
              <div className="rounded-xl border border-border bg-card p-4 space-y-3">
                <h3 className="text-sm font-semibold flex items-center gap-2">
                  <Sparkles className="size-4 text-amber-500" />
                  Тенденции и вовлечённость
                </h3>

                <div className="space-y-2.5 text-xs">
                  <div className="flex items-center justify-between p-2.5 rounded-lg bg-muted/30 border border-border/60">
                    <div>
                      <div className="font-medium">Недельная активность (WAU)</div>
                      <div className="text-[11px] text-muted-foreground">
                        Текущие 7 дн. против прошлых 7 дн.
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="font-mono font-bold text-sm">
                        {stats.kpis.wauCurrent} <span className="text-muted-foreground font-normal">/ {stats.kpis.wauPrev}</span>
                      </div>
                      <TrendPill trend={wauTrend} />
                    </div>
                  </div>

                  <div className="flex items-center justify-between p-2.5 rounded-lg bg-muted/30 border border-border/60">
                    <div>
                      <div className="font-medium">Прирост пользователей (7 дн.)</div>
                      <div className="text-[11px] text-muted-foreground">
                        Новые аккаунты за неделю
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="font-mono font-bold text-sm">
                        +{stats.kpis.newUsers7d} <span className="text-muted-foreground font-normal">/ +{stats.kpis.newUsersPrev7d}</span>
                      </div>
                      <TrendPill trend={regTrend} />
                    </div>
                  </div>

                  <div className="flex items-center justify-between p-2.5 rounded-lg bg-muted/30 border border-border/60">
                    <div>
                      <div className="font-medium">Ручные правки и слоты</div>
                      <div className="text-[11px] text-muted-foreground">
                        Среднее кол-во правок на юзера
                      </div>
                    </div>
                    <div className="text-right font-mono">
                      <div className="font-bold text-sm">
                        {stats.kpis.totalUsers > 0
                          ? (stats.kpis.totalOverrides / stats.kpis.totalUsers).toFixed(1)
                          : "0.0"}{" "}
                        дн.
                      </div>
                      <div className="text-[11px] text-muted-foreground">
                        интервалов: {stats.kpis.totalIntervals}
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Распределение режимов графиков */}
              <div className="rounded-xl border border-border bg-card p-4 space-y-3">
                <h3 className="text-sm font-semibold flex items-center gap-2">
                  <CalendarCheck2 className="size-4 text-primary" />
                  Режимы графиков пользователей
                </h3>

                <div className="space-y-2.5">
                  {stats.scheduleModes.map((item) => {
                    const meta = MODE_LABELS[item.mode] || {
                      label: item.mode,
                      color: "#6366f1",
                    };
                    const pct =
                      stats.kpis.totalUsers > 0
                        ? Math.round((item.count / stats.kpis.totalUsers) * 100)
                        : 0;
                    return (
                      <div key={item.mode} className="space-y-1 text-xs">
                        <div className="flex items-center justify-between">
                          <span className="font-medium">{meta.label}</span>
                          <span className="font-mono text-muted-foreground">
                            {item.count} ({pct}%)
                          </span>
                        </div>
                        <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                          <div
                            className="h-full rounded-full transition-all"
                            style={{ width: `${pct}%`, backgroundColor: meta.color }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </TabsContent>

        {/* =================================================================== */}
        {/* ВКЛАДКА 2: БАЗА ДАННЫХ И КАРТИНКИ В ЗАГРУЗКАХ                       */}
        {/* =================================================================== */}
        <TabsContent value="storage" className="space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Левая панель: Таблицы PostgreSQL */}
            <div className="rounded-xl border border-border bg-card p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-sm font-semibold flex items-center gap-2">
                    <Database className="size-4 text-violet-500" />
                    Детализация веса БД PostgreSQL
                  </h2>
                  <p className="text-xs text-muted-foreground">
                    Полный размер базы: <strong>{formatBytes(stats.database.totalDbBytes)}</strong> (схема{" "}
                    <code className="font-mono">{stats.database.schemaName}</code>:{" "}
                    {formatBytes(stats.database.schemaTablesBytes)})
                  </p>
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-xs text-left border-collapse">
                  <thead>
                    <tr className="border-b border-border bg-muted/40 text-muted-foreground">
                      <th className="p-2 font-semibold">Таблица</th>
                      <th className="p-2 font-semibold text-right">Строк (~)</th>
                      <th className="p-2 font-semibold text-right">Данные</th>
                      <th className="p-2 font-semibold text-right">Индексы/TOAST</th>
                      <th className="p-2 font-semibold text-right">Всего</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.database.tables.map((t) => {
                      const sharePct =
                        stats.database.schemaTablesBytes > 0
                          ? Math.round((t.totalBytes / stats.database.schemaTablesBytes) * 100)
                          : 0;
                      return (
                        <tr key={t.tableName} className="border-b border-border/60 hover:bg-muted/20">
                          <td className="p-2 font-mono font-medium">
                            <div className="flex items-center gap-2">
                              <span>{t.tableName}</span>
                              <span className="text-[10px] text-muted-foreground">{sharePct}%</span>
                            </div>
                          </td>
                          <td className="p-2 font-mono text-right">{t.rowEstimate}</td>
                          <td className="p-2 font-mono text-right text-muted-foreground">
                            {formatBytes(t.dataBytes)}
                          </td>
                          <td className="p-2 font-mono text-right text-muted-foreground">
                            {formatBytes(t.indexToastBytes)}
                          </td>
                          <td className="p-2 font-mono text-right font-semibold">
                            {formatBytes(t.totalBytes)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Правая панель: Вес картинок в /uploads и очистка */}
            <div className="rounded-xl border border-border bg-card p-4 space-y-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h2 className="text-sm font-semibold flex items-center gap-2">
                    <ImageIcon className="size-4 text-pink-500" />
                    Хранилище картинок в <code className="font-mono">/uploads</code>
                  </h2>
                  <p className="text-xs text-muted-foreground">
                    Всего файлов: <strong>{stats.media.totalFiles}</strong> на сумму{" "}
                    <strong>{formatBytes(stats.media.totalBytes)}</strong>
                  </p>
                </div>

                {stats.media.orphanedFilesCount > 0 && (
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={cleaningMedia}
                    onClick={handleCleanupOrphanedMedia}
                    data-testid="admin-cleanup-orphans-btn"
                  >
                    <Trash2 className="size-3.5" />
                    Очистить неиспользуемые ({stats.media.orphanedFilesCount} —{" "}
                    {formatBytes(stats.media.orphanedBytes)})
                  </Button>
                )}
              </div>

              {/* Разбивка по категориям картинок */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {(["avatar", "banner", "icon", "other"] as const).map((k) => {
                  const info = stats.media.byKind[k];
                  const meta = KIND_LABELS[k];
                  return (
                    <div
                      key={k}
                      className="rounded-lg border border-border bg-muted/25 p-2.5 space-y-1"
                    >
                      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                        <span
                          className="size-2 rounded-full shrink-0"
                          style={{ backgroundColor: meta.color }}
                        />
                        <span className="truncate">{meta.label}</span>
                      </div>
                      <div className="font-mono font-bold text-sm">{formatBytes(info.bytes)}</div>
                      <div className="text-[10px] font-mono text-muted-foreground">
                        {info.count} файл(ов)
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Статус осиротевших файлов */}
              {stats.media.orphanedFilesCount === 0 ? (
                <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300">
                  <CheckCircle2 className="size-4 shrink-0" />
                  <span>
                    Все файлы в папке <code className="font-mono">/uploads</code> привязаны к профилям пользователей. Мусорных файлов нет.
                  </span>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="text-xs font-medium text-amber-600 dark:text-amber-400">
                    Неиспользуемые (осиротевшие) файлы ({stats.media.orphanedFilesCount}):
                  </div>
                  <div className="max-h-40 overflow-y-auto rounded-lg border border-border divide-y divide-border text-xs">
                    {stats.media.orphanedFiles.map((f) => (
                      <div
                        key={f.name}
                        className="flex items-center justify-between gap-2 px-2.5 py-1.5 hover:bg-muted/30"
                      >
                        <a
                          href={f.url}
                          target="_blank"
                          rel="noreferrer"
                          className="font-mono truncate hover:underline flex items-center gap-1.5"
                        >
                          <span>{f.name}</span>
                          <ExternalLink className="size-3 opacity-60 shrink-0" />
                        </a>
                        <span className="font-mono text-muted-foreground shrink-0">
                          {formatBytes(f.sizeBytes)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Топ самых тяжёлых картинок */}
              {stats.media.largestFiles.length > 0 && (
                <div className="space-y-1.5">
                  <div className="text-xs font-semibold text-muted-foreground">
                    Самые крупные файлы в загрузках:
                  </div>
                  <div className="max-h-48 overflow-y-auto rounded-lg border border-border divide-y divide-border text-xs">
                    {stats.media.largestFiles.slice(0, 8).map((f) => (
                      <div
                        key={f.name}
                        className="flex items-center justify-between gap-2 px-2.5 py-1.5"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <img
                            src={f.url}
                            alt={f.name}
                            className="size-6 rounded object-cover border border-border bg-muted shrink-0"
                          />
                          <a
                            href={f.url}
                            target="_blank"
                            rel="noreferrer"
                            className="font-mono truncate hover:underline"
                          >
                            {f.name}
                          </a>
                          {!f.isReferenced && (
                            <Badge variant="outline" className="text-[10px] text-amber-500 border-amber-500/40">
                              сирота
                            </Badge>
                          )}
                        </div>
                        <span className="font-mono font-medium shrink-0">
                          {formatBytes(f.sizeBytes)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </TabsContent>

        {/* =================================================================== */}
        {/* ВКЛАДКА 3: УПРАВЛЕНИЕ АДМИНИСТРАТОРАМИ (@qkeeper — главный админ)   */}
        {/* =================================================================== */}
        <TabsContent value="admins" className="space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {/* Левая карточка: Назначение нового админа */}
            <div className="rounded-xl border border-border bg-card p-4 space-y-3">
              <div className="flex items-center gap-2">
                <Crown className="size-4 text-amber-500" />
                <h2 className="text-sm font-semibold">Назначить администратора</h2>
              </div>
              <p className="text-xs text-muted-foreground">
                Главным администратором системы является{" "}
                <strong className="font-mono text-foreground">@{stats.superAdminUsername}</strong>.{" "}
                {isSuperAdmin
                  ? "Вы вошли как главный администратор и можете назначать или снимать других админов."
                  : "Назначать и разжаловать других администраторов может только главный администратор (@qkeeper)."}
              </p>

              <form onSubmit={handleGrantByUsername} className="space-y-2.5 pt-1">
                <Input
                  value={newAdminInput}
                  onChange={(e) => setNewAdminInput(e.target.value)}
                  placeholder="Введите @username пользователя"
                  disabled={!isSuperAdmin || adminMutatingId !== null}
                  data-testid="admin-grant-username-input"
                  className="font-mono text-xs"
                />
                <Button
                  type="submit"
                  size="sm"
                  className="w-full"
                  disabled={!isSuperAdmin || !newAdminInput.trim() || adminMutatingId !== null}
                  data-testid="admin-grant-submit-btn"
                >
                  <UserPlus className="size-3.5" />
                  Назначить админом
                </Button>
              </form>
            </div>

            {/* Правая карточка: Список действующих администраторов */}
            <div className="lg:col-span-2 rounded-xl border border-border bg-card p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold">
                  Действующие администраторы ({adminsList.length})
                </h2>
              </div>

              <div className="space-y-2">
                {adminsList.map((adm) => (
                  <div
                    key={adm.id}
                    data-testid={`admin-member-row-${adm.username}`}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/20 p-3"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <span
                        className="size-9 rounded-full overflow-hidden flex items-center justify-center text-white font-semibold text-xs shrink-0"
                        style={{
                          backgroundColor: adm.avatar_url ? undefined : adm.avatar_color,
                        }}
                      >
                        {adm.avatar_url ? (
                          <img
                            src={adm.avatar_url}
                            alt={adm.display_name}
                            className="size-full object-cover"
                          />
                        ) : (
                          adm.display_name.slice(0, 1).toUpperCase()
                        )}
                      </span>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-semibold truncate">{adm.display_name}</span>
                          <span className="text-xs font-mono text-muted-foreground">
                            @{adm.username}
                          </span>
                          {adm.is_super_admin ? (
                            <Badge className="bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30 gap-1 text-[10px]">
                              <Crown className="size-3" />
                              Главный админ
                            </Badge>
                          ) : (
                            <Badge variant="secondary" className="text-[10px] gap-1">
                              <ShieldCheck className="size-3 text-primary" />
                              Админ
                            </Badge>
                          )}
                        </div>
                        <div className="text-[11px] text-muted-foreground">
                          Активных дней: {adm.active_days_count} · Групп: {adm.groups_count} · Правок:{" "}
                          {adm.overrides_count}
                        </div>
                      </div>
                    </div>

                    {!adm.is_super_admin && isSuperAdmin && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={adminMutatingId === adm.id}
                        onClick={() => handleToggleAdmin(adm, false)}
                        data-testid={`admin-revoke-btn-${adm.username}`}
                        className="text-destructive hover:text-destructive"
                      >
                        <UserMinus className="size-3.5" />
                        Снять права
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </TabsContent>

        {/* =================================================================== */}
        {/* ВКЛАДКА 4: ТАБЛИЦА ВСЕХ ПОЛЬЗОВАТЕЛЕЙ И ГРУПП                        */}
        {/* =================================================================== */}
        <TabsContent value="users" className="space-y-6">
          {/* Таблица пользователей */}
          <div className="rounded-xl border border-border bg-card p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold">
                  Все пользователи системы ({filteredUsers.length} из {stats.users.length})
                </h2>
                <p className="text-xs text-muted-foreground">
                  Статистика активности, режим расписания и быстрое управление ролями администраторов
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <div className="inline-flex rounded-lg bg-muted p-[3px] border border-border text-xs">
                  <button
                    type="button"
                    onClick={() => setUserRoleFilter("all")}
                    className={`px-2.5 py-1 rounded-md font-medium cursor-pointer ${
                      userRoleFilter === "all"
                        ? "bg-background text-foreground shadow-xs"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    Все ({stats.users.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setUserRoleFilter("admins")}
                    className={`px-2.5 py-1 rounded-md font-medium cursor-pointer ${
                      userRoleFilter === "admins"
                        ? "bg-background text-foreground shadow-xs"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    Админы ({adminsList.length})
                  </button>
                </div>

                <div className="relative w-56">
                  <Search className="size-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={userSearch}
                    onChange={(e) => setUserSearch(e.target.value)}
                    placeholder="Поиск по @username или имени..."
                    className="pl-8 h-8 text-xs"
                    data-testid="admin-users-search"
                  />
                </div>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-xs text-left border-collapse">
                <thead>
                  <tr className="border-b border-border bg-muted/40 text-muted-foreground">
                    <th className="p-2 font-semibold">ID</th>
                    <th className="p-2 font-semibold">Пользователь</th>
                    <th className="p-2 font-semibold">Роль</th>
                    <th className="p-2 font-semibold">График / Пояс</th>
                    <th className="p-2 font-semibold text-right">Групп</th>
                    <th className="p-2 font-semibold text-right">Правок</th>
                    <th className="p-2 font-semibold text-right">Последняя активность</th>
                    {isSuperAdmin && <th className="p-2 font-semibold text-right">Действие</th>}
                  </tr>
                </thead>
                <tbody>
                  {filteredUsers.map((u) => (
                    <tr key={u.id} className="border-b border-border/60 hover:bg-muted/20">
                      <td className="p-2 font-mono text-muted-foreground">#{u.id}</td>
                      <td className="p-2">
                        <div className="flex items-center gap-2">
                          <span
                            className="size-6 rounded-full overflow-hidden flex items-center justify-center text-white font-semibold text-[10px] shrink-0"
                            style={{
                              backgroundColor: u.avatar_url ? undefined : u.avatar_color,
                            }}
                          >
                            {u.avatar_url ? (
                              <img
                                src={u.avatar_url}
                                alt={u.display_name}
                                className="size-full object-cover"
                              />
                            ) : (
                              u.display_name.slice(0, 1).toUpperCase()
                            )}
                          </span>
                          <div>
                            <div className="font-medium leading-tight">{u.display_name}</div>
                            <div className="font-mono text-[11px] text-muted-foreground">
                              @{u.username}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="p-2">
                        {u.is_super_admin ? (
                          <Badge className="bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30 gap-1 text-[10px]">
                            <Crown className="size-3" />
                            Главный админ
                          </Badge>
                        ) : u.is_admin ? (
                          <Badge variant="secondary" className="text-[10px] gap-1">
                            <ShieldCheck className="size-3 text-primary" />
                            Админ
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground">Пользователь</span>
                        )}
                      </td>
                      <td className="p-2 font-mono text-[11px]">
                        <div>{u.schedule_mode}</div>
                        <div className="text-muted-foreground">{u.time_zone}</div>
                      </td>
                      <td className="p-2 font-mono text-right">{u.groups_count}</td>
                      <td className="p-2 font-mono text-right">{u.overrides_count}</td>
                      <td className="p-2 font-mono text-right text-muted-foreground">
                        {u.last_seen_at
                          ? format(parseISO(u.last_seen_at), "dd.MM.yyyy HH:mm", { locale: ru })
                          : "—"}
                      </td>
                      {isSuperAdmin && (
                        <td className="p-2 text-right">
                          {!u.is_super_admin && (
                            <Button
                              size="xs"
                              variant={u.is_admin ? "outline" : "secondary"}
                              disabled={adminMutatingId === u.id}
                              onClick={() => handleToggleAdmin(u, !u.is_admin)}
                              data-testid={`admin-toggle-user-${u.username}`}
                            >
                              {u.is_admin ? "Разжаловать" : "Сделать админом"}
                            </Button>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Таблица групп */}
          <div className="rounded-xl border border-border bg-card p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <FolderGit2 className="size-4 text-blue-500" />
                <h2 className="text-sm font-semibold">
                  Все группы ({filteredGroups.length} из {stats.groups.length})
                </h2>
              </div>
              <div className="relative w-56">
                <Search className="size-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={groupSearch}
                  onChange={(e) => setGroupSearch(e.target.value)}
                  placeholder="Поиск по группам..."
                  className="pl-8 h-8 text-xs"
                />
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-xs text-left border-collapse">
                <thead>
                  <tr className="border-b border-border bg-muted/40 text-muted-foreground">
                    <th className="p-2 font-semibold">ID</th>
                    <th className="p-2 font-semibold">Название</th>
                    <th className="p-2 font-semibold">Владелец</th>
                    <th className="p-2 font-semibold text-right">Участников</th>
                    <th className="p-2 font-semibold text-right">Ожидают (pending)</th>
                    <th className="p-2 font-semibold text-right">Создана</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredGroups.map((g) => (
                    <tr key={g.id} className="border-b border-border/60 hover:bg-muted/20">
                      <td className="p-2 font-mono text-muted-foreground">#{g.id}</td>
                      <td className="p-2">
                        <div className="font-medium">{g.name}</div>
                        {g.description && (
                          <div className="text-[11px] text-muted-foreground truncate max-w-xs">
                            {g.description}
                          </div>
                        )}
                      </td>
                      <td className="p-2 font-mono">
                        {g.owner_username ? `@${g.owner_username}` : `id=${g.owner_id}`}
                      </td>
                      <td className="p-2 font-mono text-right font-semibold">
                        {g.accepted_members_count}
                      </td>
                      <td className="p-2 font-mono text-right text-muted-foreground">
                        {g.pending_members_count}
                      </td>
                      <td className="p-2 font-mono text-right text-muted-foreground">
                        {g.created_at
                          ? format(parseISO(g.created_at), "dd.MM.yyyy", { locale: ru })
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function TrendPill({
  trend,
  suffix,
}: {
  trend: { label: string; direction: "up" | "down" | "flat" };
  suffix?: string;
}) {
  const Icon =
    trend.direction === "up"
      ? TrendingUp
      : trend.direction === "down"
      ? TrendingDown
      : Minus;
  const colorCls =
    trend.direction === "up"
      ? "text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border-emerald-500/25"
      : trend.direction === "down"
      ? "text-rose-600 dark:text-rose-400 bg-rose-500/10 border-rose-500/25"
      : "text-muted-foreground bg-muted border-border";

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-mono font-medium ${colorCls}`}
    >
      <Icon className="size-3" />
      <span>{trend.label}</span>
      {suffix && <span className="opacity-75 font-sans">{suffix}</span>}
    </span>
  );
}
