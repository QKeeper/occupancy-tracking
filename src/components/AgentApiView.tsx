import React, { useState, useEffect, useMemo } from "react";
import { User, Group, DayOverride, ScheduleConfig, TimeSlot } from "@/types";
import {
  getUserDaySchedule,
  computeCombinationOverlap,
  DEFAULT_SCHEDULE_TIMEZONE,
} from "@/lib/schedule-engine";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { format } from "date-fns";
import { ru } from "date-fns/locale/ru";
import { toast } from "sonner";
import {
  Bot,
  Copy,
  Check,
  Play,
  ExternalLink,
  FileJson,
  FileText,
  Calendar,
  Terminal,
  ArrowLeft,
  RefreshCw,
} from "lucide-react";

interface AgentApiViewProps {
  currentUser: User | null;
  groups: Group[];
  activeGroup: Group | null;
  groupMembers: User[];
  days: Date[];
  onSelectGroup: (groupId: number) => void;
  onSaveDayOverride: (userId: number, dateStr: string, override: DayOverride | null) => Promise<void>;
  onSaveUserProfile: (updated: Partial<User>) => Promise<void>;
  onRefreshData: () => Promise<void>;
  onCloseAgentView: () => void;
}

interface OpenApiParameter {
  name: string;
  in: "path" | "query";
  required?: boolean;
  description?: string;
  schema?: {
    type?: string;
    default?: any;
    example?: any;
    enum?: string[];
  };
}

interface OpenApiOperation {
  tags?: string[];
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: OpenApiParameter[];
  requestBody?: {
    required?: boolean;
    content?: {
      "application/json"?: {
        schema?: any;
        examples?: Record<string, { summary?: string; value?: any }>;
      };
    };
  };
  responses?: Record<string, { description?: string }>;
}

const METHOD_COLORS: Record<string, string> = {
  GET: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  POST: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  PUT: "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30",
  PATCH: "bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/30",
  DELETE: "bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30",
};

function parseSlotsText(raw: string): TimeSlot[] {
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [start, end] = part.split("-").map((s) => s.trim());
      return { start: start || "09:00", end: end || "18:00" };
    })
    .filter((s) => /^\d{2}:\d{2}$/.test(s.start) && /^\d{2}:\d{2}$/.test(s.end));
}

export function AgentApiView({
  currentUser,
  groups,
  activeGroup,
  groupMembers,
  days,
  onSelectGroup,
  onSaveDayOverride,
  onSaveUserProfile,
  onRefreshData,
  onCloseAgentView,
}: AgentApiViewProps) {
  const [openApiSpec, setOpenApiSpec] = useState<any>(null);
  const [llmsTxt, setLlmsTxt] = useState<string>("");
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Quick Action states (Flat Agent Forms)
  const todayStr = useMemo(() => format(new Date(), "yyyy-MM-dd"), []);
  const [ovDate, setOvDate] = useState<string>(todayStr);
  const [ovStatus, setOvStatus] = useState<"working" | "free" | "partial">("working");
  const [ovSlotsText, setOvSlotsText] = useState<string>("10:00-18:00");
  const [ovNote, setOvNote] = useState<string>("");
  const [ovBusy, setOvBusy] = useState(false);

  const [schedMode, setSchedMode] = useState<"fixed_weekly" | "shift_cycle" | "manual">(
    currentUser?.schedule_config?.mode || "fixed_weekly"
  );
  const [schedJson, setSchedJson] = useState<string>(() =>
    JSON.stringify(currentUser?.schedule_config || { mode: "fixed_weekly" }, null, 2)
  );

  const [inviteUsername, setInviteUsername] = useState<string>("");
  const [newGroupName, setNewGroupName] = useState<string>("");
  const [newGroupDesc, setNewGroupDesc] = useState<string>("");

  useEffect(() => {
    if (currentUser?.schedule_config) {
      setSchedMode(currentUser.schedule_config.mode);
      setSchedJson(JSON.stringify(currentUser.schedule_config, null, 2));
    }
  }, [currentUser]);

  useEffect(() => {
    fetch("/api/openapi.json")
      .then((r) => r.json())
      .then((data) => setOpenApiSpec(data))
      .catch((err) => console.error("Failed to load openapi.json:", err));

    fetch("/api/llms.txt")
      .then((r) => r.text())
      .then((txt) => setLlmsTxt(txt))
      .catch((err) => console.error("Failed to load llms.txt:", err));
  }, []);

  const copyText = (key: string, text: string, label = "Скопировано в буфер обмена") => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    toast.success(label);
    setTimeout(() => setCopiedKey(null), 1800);
  };

  // Precomputed compact summary of current group's schedule & common free windows for LLM reading
  const agentScheduleSnapshot = useMemo(() => {
    const viewerTz = currentUser?.time_zone || DEFAULT_SCHEDULE_TIMEZONE;
    const daySummaries = days.map((d) => {
      const overlap = computeCombinationOverlap(groupMembers, d, "09:00", "23:00", 2, viewerTz);
      const memberStatuses = groupMembers.map((m) => {
        const s = getUserDaySchedule(m, d, viewerTz);
        return {
          userId: m.id,
          username: `@${m.username}`,
          displayName: m.display_name,
          status: s.status,
          busySlots: s.slots.map((sl) => `${sl.start}-${sl.end}`),
          freeIntervals: s.freeIntervals.map((fi) => `${fi.start}-${fi.end} (${fi.durationHours}ч)`),
          isOverride: s.isOverride,
          note: s.note || null,
        };
      });
      return {
        date: overlap.dateStr,
        weekday: format(d, "EEE", { locale: ru }),
        allFreeFullDay: overlap.allFreeFullDay,
        commonFreeWindows: overlap.commonFreeWindows.map(
          (w) => `${w.start}-${w.end} (${w.durationHours}ч)`
        ),
        members: memberStatuses,
      };
    });

    return {
      currentUser: currentUser
        ? {
            id: currentUser.id,
            username: `@${currentUser.username}`,
            displayName: currentUser.display_name,
            timeZone: viewerTz,
            scheduleMode: currentUser.schedule_config?.mode,
          }
        : null,
      activeGroup: activeGroup
        ? {
            id: activeGroup.id,
            name: activeGroup.name,
            description: activeGroup.description,
            ownerId: activeGroup.owner_id,
            memberCount: groupMembers.length,
          }
        : null,
      endpoints: {
        openApiJson: "/api/openapi.json",
        llmsTxt: "/api/llms.txt",
        groupAvailability: activeGroup
          ? `/api/groups/${activeGroup.id}/availability?startDate=${format(days[0], "yyyy-MM-dd")}&days=${days.length}`
          : "/api/groups/{groupId}/availability",
      },
      days: daySummaries,
    };
  }, [currentUser, activeGroup, groupMembers, days]);

  const handleQuickOverrideSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentUser) {
      toast.error("Сначала войдите в аккаунт");
      return;
    }
    setOvBusy(true);
    try {
      const slots = ovStatus === "free" ? [] : parseSlotsText(ovSlotsText);
      await onSaveDayOverride(currentUser.id, ovDate, {
        status: ovStatus,
        slots,
        ...(ovNote.trim() ? { note: ovNote.trim() } : {}),
      });
      toast.success(`Правка на ${ovDate} сохранена`);
    } catch (err: any) {
      toast.error(err.message || "Ошибка сохранения правки");
    } finally {
      setOvBusy(false);
    }
  };

  const handleQuickOverrideDelete = async () => {
    if (!currentUser) return;
    setOvBusy(true);
    try {
      await onSaveDayOverride(currentUser.id, ovDate, null);
      toast.success(`Правка на ${ovDate} сброшена к базовому графику`);
    } catch (err: any) {
      toast.error(err.message || "Ошибка удаления правки");
    } finally {
      setOvBusy(false);
    }
  };

  const handleQuickSaveScheduleConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentUser) return;
    try {
      const parsed: ScheduleConfig = JSON.parse(schedJson);
      parsed.mode = schedMode;
      await onSaveUserProfile({ schedule_config: parsed });
      toast.success("Базовый график обновлён");
    } catch (err: any) {
      toast.error(`Ошибка JSON или сохранения: ${err.message}`);
    }
  };

  const handleQuickInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeGroup || !currentUser || !inviteUsername.trim()) return;
    try {
      const res = await fetch(`/api/groups/${activeGroup.id}/invite`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: inviteUsername.trim(),
          invited_by: currentUser.id,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Ошибка приглашения");
      toast.success(data.message || "Приглашение отправлено");
      setInviteUsername("");
      await onRefreshData();
    } catch (err: any) {
      toast.error(err.message);
    }
  };

  const handleQuickCreateGroup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentUser || !newGroupName.trim()) return;
    try {
      const res = await fetch("/api/groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newGroupName.trim(),
          description: newGroupDesc.trim(),
          owner_id: currentUser.id,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Ошибка создания группы");
      toast.success(`Группа «${data.name}» создана`);
      setNewGroupName("");
      setNewGroupDesc("");
      await onRefreshData();
      onSelectGroup(data.id);
    } catch (err: any) {
      toast.error(err.message);
    }
  };

  // Extract flat list of operations grouped by tag from OpenAPI spec
  const operationsByTag = useMemo(() => {
    if (!openApiSpec?.paths) return [];
    const map = new Map<
      string,
      { tag: string; description?: string; items: { path: string; method: string; op: OpenApiOperation }[] }
    >();

    for (const t of openApiSpec.tags || []) {
      map.set(t.name, { tag: t.name, description: t.description, items: [] });
    }

    for (const [pathStr, pathObj] of Object.entries<any>(openApiSpec.paths)) {
      for (const method of ["get", "post", "put", "patch", "delete"]) {
        if (pathObj[method]) {
          const op: OpenApiOperation = pathObj[method];
          const tagName = op.tags?.[0] || "Other";
          if (!map.has(tagName)) {
            map.set(tagName, { tag: tagName, items: [] });
          }
          map.get(tagName)!.items.push({
            path: pathStr,
            method: method.toUpperCase(),
            op,
          });
        }
      }
    }

    return Array.from(map.values()).filter((g) => g.items.length > 0);
  }, [openApiSpec]);

  return (
    <div
      id="agent-openapi-interface"
      data-testid="agent-openapi-interface"
      data-current-user-id={currentUser?.id ?? ""}
      data-current-username={currentUser?.username ?? ""}
      data-active-group-id={activeGroup?.id ?? ""}
      className="space-y-6"
    >
      {/* Верхняя панель режима агента / OpenAPI */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card p-4 shadow-xs">
        <div className="flex items-start gap-3">
          <div className="rounded-md bg-primary/10 p-2 text-primary">
            <Bot className="size-5" />
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-base font-semibold tracking-tight">
                OpenAPI 3.1 & Упрощённый интерфейс для ИИ-агентов
              </h1>
              <Badge variant="secondary" className="font-mono text-[11px]">
                OpenAPI 3.1.0
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              Машиночитаемая документация всех эндпоинтов, интерактивная консоль запросов и плоские HTML-формы без модальных окон.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <a
            href="/api/openapi.json"
            target="_blank"
            rel="noreferrer"
            data-testid="link-openapi-json"
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs font-mono hover:bg-accent"
          >
            <FileJson className="size-3.5 text-blue-500" />
            /api/openapi.json
            <ExternalLink className="size-3 opacity-60" />
          </a>
          <a
            href="/api/llms.txt"
            target="_blank"
            rel="noreferrer"
            data-testid="link-llms-txt"
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs font-mono hover:bg-accent"
          >
            <FileText className="size-3.5 text-emerald-500" />
            /api/llms.txt
            <ExternalLink className="size-3 opacity-60" />
          </a>
          <Button
            variant="outline"
            size="sm"
            onClick={() => copyText("llms", llmsTxt, "Инструкция llms.txt скопирована")}
            data-testid="btn-copy-llms-txt"
          >
            {copiedKey === "llms" ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            Скопировать промпт для LLM
          </Button>
          <Button
            variant="default"
            size="sm"
            onClick={onCloseAgentView}
            data-testid="btn-close-agent-view"
          >
            <ArrowLeft className="size-3.5" />
            Обычный календарь
          </Button>
        </div>
      </div>

      {/* Машиночитаемый контекст текущей сессии */}
      <section
        aria-label="Контекст текущей сессии агента"
        className="rounded-lg border border-border bg-muted/20 p-3.5 text-xs space-y-2"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-semibold uppercase tracking-wider text-[11px] text-muted-foreground">
            Текущий контекст сессии (Session Context)
          </span>
          <div className="flex items-center gap-2">
            {groups.filter((g) => g.my_status === "accepted").length > 1 && (
              <div className="flex items-center gap-1.5">
                <Label htmlFor="agent-group-select" className="text-xs">
                  Активная группа:
                </Label>
                <Select
                  value={activeGroup ? String(activeGroup.id) : undefined}
                  onValueChange={(val) => onSelectGroup(Number(val))}
                >
                  <SelectTrigger
                    id="agent-group-select"
                    data-testid="agent-group-select"
                    size="sm"
                    className="w-auto min-w-[140px] text-xs font-medium"
                  >
                    <SelectValue placeholder="Выберите группу" />
                  </SelectTrigger>
                  <SelectContent>
                    {groups
                      .filter((g) => g.my_status === "accepted")
                      .map((g) => (
                        <SelectItem key={g.id} value={String(g.id)}>
                          #{g.id} — {g.name}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={onRefreshData}
              title="Обновить данные"
              data-testid="agent-refresh-btn"
            >
              <RefreshCw className="size-3.5" />
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 font-mono">
          <div className="rounded border border-border bg-background px-3 py-2">
            <div className="text-[10px] text-muted-foreground">АКТИВНЫЙ ПОЛЬЗОВАТЕЛЬ</div>
            <div data-testid="context-user">
              {currentUser
                ? `id=${currentUser.id} (@${currentUser.username} — ${currentUser.display_name})`
                : "Не авторизован"}
            </div>
          </div>
          <div className="rounded border border-border bg-background px-3 py-2">
            <div className="text-[10px] text-muted-foreground">АКТИВНАЯ ГРУППА</div>
            <div data-testid="context-group">
              {activeGroup
                ? `groupId=${activeGroup.id} («${activeGroup.name}», участников: ${groupMembers.length})`
                : "Нет выбранной группы"}
            </div>
          </div>
          <div className="rounded border border-border bg-background px-3 py-2">
            <div className="text-[10px] text-muted-foreground">БЫСТРЫЙ ЗАПРОС СВОБОДНЫХ ОКОН</div>
            <div className="truncate" data-testid="context-availability-url">
              {activeGroup
                ? `GET /api/groups/${activeGroup.id}/availability`
                : "GET /api/groups/{groupId}/availability"}
            </div>
          </div>
        </div>
      </section>

      <Tabs defaultValue="openapi" className="space-y-4">
        <TabsList className="flex flex-wrap h-auto gap-1">
          <TabsTrigger value="openapi" data-testid="tab-openapi-explorer">
            <Terminal className="size-3.5 mr-1.5" />
            OpenAPI Эндпоинты ({operationsByTag.reduce((a, b) => a + b.items.length, 0)})
          </TabsTrigger>
          <TabsTrigger value="quick-actions" data-testid="tab-agent-actions">
            <Calendar className="size-3.5 mr-1.5" />
            Табличная сводка и быстрые формы (DOM для агентов)
          </TabsTrigger>
          <TabsTrigger value="raw-spec" data-testid="tab-raw-spec">
            <FileJson className="size-3.5 mr-1.5" />
            Сырой OpenAPI JSON & llms.txt
          </TabsTrigger>
        </TabsList>

        {/* Вкладка 1: Интерактивный OpenAPI Explorer */}
        <TabsContent value="openapi" className="space-y-6">
          {operationsByTag.map((group) => (
            <div key={group.tag} className="space-y-3">
              <div className="border-b border-border pb-1.5">
                <h2 className="text-sm font-semibold tracking-tight">{group.tag}</h2>
                {group.description && (
                  <p className="text-xs text-muted-foreground">{group.description}</p>
                )}
              </div>

              <div className="space-y-2.5">
                {group.items.map(({ path, method, op }) => (
                  <EndpointCard
                    key={`${method}-${path}`}
                    method={method}
                    path={path}
                    op={op}
                    currentUser={currentUser}
                    activeGroup={activeGroup}
                    todayStr={todayStr}
                    onMutationSuccess={onRefreshData}
                  />
                ))}
              </div>
            </div>
          ))}
        </TabsContent>

        {/* Вкладка 2: Плоский семантический интерфейс для браузерных агентов */}
        <TabsContent value="quick-actions" className="space-y-6">
          {/* Таблица расписания и общих свободных окон */}
          <section
            aria-label="Таблица расписания и общих свободных окон группы"
            className="rounded-lg border border-border bg-card p-4 space-y-3"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold">
                  Сводная таблица занятости и общих свободных окон (09:00–23:00)
                </h2>
                <p className="text-xs text-muted-foreground">
                  Простая семантическая HTML-таблица, которую любая нейросеть считывает без скролла и ховеров.
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  copyText(
                    "snapshot-json",
                    JSON.stringify(agentScheduleSnapshot, null, 2),
                    "JSON-сводка расписания скопирована"
                  )
                }
                data-testid="btn-copy-schedule-json"
              >
                {copiedKey === "snapshot-json" ? (
                  <Check className="size-3.5" />
                ) : (
                  <Copy className="size-3.5" />
                )}
                Скопировать сводку (JSON)
              </Button>
            </div>

            <div className="overflow-x-auto">
              <table
                data-testid="agent-schedule-table"
                className="w-full border-collapse text-xs text-left"
              >
                <thead>
                  <tr className="border-b border-border bg-muted/40">
                    <th className="p-2 font-semibold">Дата</th>
                    <th className="p-2 font-semibold">Общие окна (все свободны ≥2ч)</th>
                    {groupMembers.map((m) => (
                      <th key={m.id} className="p-2 font-semibold">
                        {m.display_name}{" "}
                        <span className="font-mono text-muted-foreground">
                          (@{m.username}, id={m.id})
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {agentScheduleSnapshot.days.map((dRow) => (
                    <tr key={dRow.date} className="border-b border-border/60">
                      <td className="p-2 font-mono whitespace-nowrap font-medium">
                        {dRow.date} ({dRow.weekday})
                      </td>
                      <td className="p-2 font-mono">
                        {dRow.commonFreeWindows.length > 0 ? (
                          <span className="text-emerald-600 dark:text-emerald-400 font-medium">
                            {dRow.commonFreeWindows.join(", ")}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">Нет общих окон</span>
                        )}
                      </td>
                      {dRow.members.map((mStat) => (
                        <td key={mStat.userId} className="p-2 font-mono">
                          {mStat.status === "free" ? (
                            <span className="text-emerald-600 dark:text-emerald-400">
                              Свободен весь день
                            </span>
                          ) : (
                            <span className="text-rose-600 dark:text-rose-400">
                              Занят: {mStat.busySlots.join(", ")}
                            </span>
                          )}
                          {mStat.isOverride && (
                            <span className="ml-1 text-[10px] text-amber-500">[правка]</span>
                          )}
                          {mStat.note && (
                            <div className="text-[11px] text-muted-foreground">
                              Примечание: {mStat.note}
                            </div>
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* Формы прямого управления (Правка на день, Базовый график, Группы) */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Форма 1: Правка на конкретную дату */}
            <form
              onSubmit={handleQuickOverrideSave}
              data-testid="agent-form-day-override"
              aria-label="Установить или удалить правку на конкретный день"
              className="rounded-lg border border-border bg-card p-4 space-y-3"
            >
              <h3 className="text-sm font-semibold">
                1. Быстрая правка на дату (PUT /api/users/{currentUser?.id ?? ":id"}/overrides/:date)
              </h3>
              <div className="grid grid-cols-2 gap-2.5">
                <div className="space-y-1">
                  <Label htmlFor="agent-ov-date" className="text-xs">
                    Дата (YYYY-MM-DD)
                  </Label>
                  <Input
                    id="agent-ov-date"
                    data-testid="agent-ov-date"
                    type="date"
                    value={ovDate}
                    onChange={(e) => setOvDate(e.target.value)}
                    className="font-mono text-xs"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="agent-ov-status" className="text-xs">
                    Статус дня
                  </Label>
                  <Select
                    value={ovStatus}
                    onValueChange={(val) => setOvStatus(val as any)}
                  >
                    <SelectTrigger
                      id="agent-ov-status"
                      data-testid="agent-ov-status"
                      size="default"
                      className="w-full text-xs"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="working">working (Занят в указанные часы)</SelectItem>
                      <SelectItem value="free">free (Полностью свободен / Выходной)</SelectItem>
                      <SelectItem value="partial">partial (Частично занят)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {ovStatus !== "free" && (
                <div className="space-y-1">
                  <Label htmlFor="agent-ov-slots" className="text-xs">
                    Интервалы занятости (HH:MM-HH:MM через запятую)
                  </Label>
                  <Input
                    id="agent-ov-slots"
                    data-testid="agent-ov-slots"
                    value={ovSlotsText}
                    onChange={(e) => setOvSlotsText(e.target.value)}
                    placeholder="09:00-18:00, 20:00-22:00"
                    className="font-mono text-xs"
                  />
                </div>
              )}

              <div className="space-y-1">
                <Label htmlFor="agent-ov-note" className="text-xs">
                  Заметка к дню (необязательно)
                </Label>
                <Input
                  id="agent-ov-note"
                  data-testid="agent-ov-note"
                  value={ovNote}
                  onChange={(e) => setOvNote(e.target.value)}
                  placeholder="Например: Отгул / Дежурство"
                  className="text-xs"
                />
              </div>

              <div className="flex items-center gap-2 pt-1">
                <Button
                  type="submit"
                  size="sm"
                  disabled={ovBusy || !currentUser}
                  data-testid="agent-ov-submit"
                >
                  Сохранить правку на {ovDate}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={ovBusy || !currentUser}
                  onClick={handleQuickOverrideDelete}
                  data-testid="agent-ov-delete"
                >
                  Сбросить правку
                </Button>
              </div>
            </form>

            {/* Форма 2: Управление группами и приглашениями */}
            <div className="rounded-lg border border-border bg-card p-4 space-y-4">
              <form
                onSubmit={handleQuickInvite}
                data-testid="agent-form-invite"
                className="space-y-2"
              >
                <h3 className="text-sm font-semibold">
                  2. Пригласить участника в текущую группу ({activeGroup?.name || "—"})
                </h3>
                <div className="flex gap-2">
                  <Input
                    data-testid="agent-invite-username"
                    value={inviteUsername}
                    onChange={(e) => setInviteUsername(e.target.value)}
                    placeholder="Введите @username"
                    className="font-mono text-xs"
                  />
                  <Button
                    type="submit"
                    size="sm"
                    disabled={!activeGroup || !inviteUsername.trim()}
                    data-testid="agent-invite-submit"
                  >
                    Пригласить
                  </Button>
                </div>
              </form>

              <form
                onSubmit={handleQuickCreateGroup}
                data-testid="agent-form-create-group"
                className="space-y-2 border-t border-border pt-3"
              >
                <h3 className="text-sm font-semibold">3. Создать новую группу (POST /api/groups)</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <Input
                    data-testid="agent-new-group-name"
                    value={newGroupName}
                    onChange={(e) => setNewGroupName(e.target.value)}
                    placeholder="Название группы"
                    className="text-xs"
                  />
                  <Input
                    data-testid="agent-new-group-desc"
                    value={newGroupDesc}
                    onChange={(e) => setNewGroupDesc(e.target.value)}
                    placeholder="Описание (необязательно)"
                    className="text-xs"
                  />
                </div>
                <Button
                  type="submit"
                  size="sm"
                  variant="secondary"
                  disabled={!newGroupName.trim()}
                  data-testid="agent-new-group-submit"
                >
                  Создать группу
                </Button>
              </form>
            </div>
          </div>

          {/* Форма 3: Редактор базового графика schedule_config */}
          <form
            onSubmit={handleQuickSaveScheduleConfig}
            data-testid="agent-form-schedule-config"
            className="rounded-lg border border-border bg-card p-4 space-y-3"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">
                4. Базовый график пользователя (PATCH /api/users/{currentUser?.id ?? ":id"}/schedule)
              </h3>
              <div className="flex items-center gap-2">
                <Label htmlFor="agent-sched-mode" className="text-xs">
                  Режим:
                </Label>
                <Select
                  value={schedMode}
                  onValueChange={(nextMode) => {
                    setSchedMode(nextMode as any);
                    try {
                      const obj = JSON.parse(schedJson);
                      obj.mode = nextMode;
                      setSchedJson(JSON.stringify(obj, null, 2));
                    } catch {
                      // ignore
                    }
                  }}
                >
                  <SelectTrigger
                    id="agent-sched-mode"
                    data-testid="agent-sched-mode"
                    size="sm"
                    className="w-auto min-w-[180px] text-xs font-mono"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="fixed_weekly">fixed_weekly (Недельный 5/2 и т.д.)</SelectItem>
                    <SelectItem value="shift_cycle">shift_cycle (Сменный N/M)</SelectItem>
                    <SelectItem value="manual">manual (Свободный / только ручные правки)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <textarea
              data-testid="agent-sched-json"
              value={schedJson}
              onChange={(e) => setSchedJson(e.target.value)}
              rows={8}
              className="w-full rounded-md border border-border bg-muted/30 p-2.5 font-mono text-xs"
            />
            <Button type="submit" size="sm" data-testid="agent-sched-submit">
              Обновить schedule_config
            </Button>
          </form>
        </TabsContent>

        {/* Вкладка 3: Сырая документация llms.txt & openapi.json */}
        <TabsContent value="raw-spec" className="space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="rounded-lg border border-border bg-card p-4 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold font-mono">/api/llms.txt</span>
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() => copyText("raw-llms", llmsTxt, "llms.txt скопирован")}
                >
                  Копировать
                </Button>
              </div>
              <pre
                data-testid="raw-llms-txt"
                className="max-h-[520px] overflow-auto rounded border border-border bg-muted/30 p-3 text-[11px] font-mono whitespace-pre-wrap"
              >
                {llmsTxt}
              </pre>
            </div>

            <div className="rounded-lg border border-border bg-card p-4 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold font-mono">/api/openapi.json</span>
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() =>
                    copyText(
                      "raw-openapi",
                      JSON.stringify(openApiSpec, null, 2),
                      "openapi.json скопирован"
                    )
                  }
                >
                  Копировать JSON
                </Button>
              </div>
              <pre
                data-testid="raw-openapi-json"
                className="max-h-[520px] overflow-auto rounded border border-border bg-muted/30 p-3 text-[11px] font-mono whitespace-pre"
              >
                {openApiSpec ? JSON.stringify(openApiSpec, null, 2) : "Загрузка..."}
              </pre>
            </div>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

interface EndpointCardProps {
  method: string;
  path: string;
  op: OpenApiOperation;
  currentUser: User | null;
  activeGroup: Group | null;
  todayStr: string;
  onMutationSuccess: () => Promise<void>;
}

function EndpointCard({
  method,
  path,
  op,
  currentUser,
  activeGroup,
  todayStr,
  onMutationSuccess,
}: EndpointCardProps) {
  const [expanded, setExpanded] = useState<boolean>(
    op.operationId === "getGroupAvailability" || op.operationId === "setUserDayOverride"
  );

  // Initialize parameter values with smart defaults from session
  const [paramValues, setParamValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const p of op.parameters || []) {
      if (p.name === "id" || p.name === "userId") {
        init[p.name] = String(currentUser?.id ?? p.schema?.example ?? 1);
      } else if (p.name === "groupId") {
        init[p.name] = String(activeGroup?.id ?? p.schema?.example ?? 1);
      } else if (p.name === "date" || p.name === "startDate") {
        init[p.name] = todayStr;
      } else if (p.schema?.default !== undefined) {
        init[p.name] = String(p.schema.default);
      } else {
        init[p.name] = "";
      }
    }
    return init;
  });

  const defaultBodyExample = useMemo(() => {
    const jsonContent = op.requestBody?.content?.["application/json"];
    if (!jsonContent) return "";
    if (jsonContent.examples) {
      const firstKey = Object.keys(jsonContent.examples)[0];
      if (firstKey && jsonContent.examples[firstKey]?.value) {
        return JSON.stringify(jsonContent.examples[firstKey].value, null, 2);
      }
    }
    const props = jsonContent.schema?.properties;
    if (props) {
      const sample: Record<string, any> = {};
      for (const [k, v] of Object.entries<any>(props)) {
        if (k === "owner_id" || k === "user_id" || k === "invited_by") {
          sample[k] = currentUser?.id ?? 1;
        } else if (v.example !== undefined) {
          sample[k] = v.example;
        }
      }
      return JSON.stringify(sample, null, 2);
    }
    return "{\n  \n}";
  }, [op, currentUser]);

  const [bodyText, setBodyText] = useState<string>(defaultBodyExample);
  const [responseState, setResponseState] = useState<{
    status: number;
    data: string;
    durationMs: number;
  } | null>(null);
  const [executing, setExecuting] = useState(false);

  const resolvedUrl = useMemo(() => {
    let url = path;
    const queryParts: string[] = [];
    for (const p of op.parameters || []) {
      const val = paramValues[p.name]?.trim() ?? "";
      if (p.in === "path") {
        url = url.replace(`{${p.name}}`, encodeURIComponent(val || `{${p.name}}`));
      } else if (p.in === "query" && val !== "") {
        queryParts.push(`${encodeURIComponent(p.name)}=${encodeURIComponent(val)}`);
      }
    }
    return queryParts.length > 0 ? `${url}?${queryParts.join("&")}` : url;
  }, [path, op.parameters, paramValues]);

  const handleExecute = async () => {
    setExecuting(true);
    const t0 = performance.now();
    try {
      const hasBody = ["POST", "PUT", "PATCH", "DELETE"].includes(method);
      const res = await fetch(resolvedUrl, {
        method,
        headers: hasBody ? { "Content-Type": "application/json" } : undefined,
        body: hasBody ? bodyText.trim() || "{}" : undefined,
      });
      const rawText = await res.text();
      let formatted = rawText;
      try {
        formatted = JSON.stringify(JSON.parse(rawText), null, 2);
      } catch {
        // leave as plain text
      }
      setResponseState({
        status: res.status,
        data: formatted,
        durationMs: Math.round(performance.now() - t0),
      });
      if (res.ok && method !== "GET") {
        await onMutationSuccess();
      }
    } catch (err: any) {
      setResponseState({
        status: 0,
        data: JSON.stringify({ error: err.message }, null, 2),
        durationMs: Math.round(performance.now() - t0),
      });
    } finally {
      setExecuting(false);
    }
  };

  return (
    <div
      data-testid={`endpoint-${op.operationId || path}`}
      className="rounded-lg border border-border bg-card overflow-hidden"
    >
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5 text-left hover:bg-muted/30 cursor-pointer"
      >
        <div className="flex flex-wrap items-center gap-2.5 min-w-0">
          <span
            className={`inline-flex items-center justify-center rounded border px-2 py-0.5 text-[11px] font-mono font-bold uppercase ${
              METHOD_COLORS[method] || "bg-muted text-foreground"
            }`}
          >
            {method}
          </span>
          <span className="font-mono text-xs font-semibold text-foreground">{path}</span>
          <span className="text-xs text-muted-foreground truncate">{op.summary}</span>
        </div>
        <span className="font-mono text-[11px] text-muted-foreground">
          {op.operationId} {expanded ? "▲" : "▼"}
        </span>
      </button>

      {expanded && (
        <div className="border-t border-border bg-muted/10 p-3.5 space-y-3 text-xs">
          {op.description && (
            <p className="text-muted-foreground leading-relaxed">{op.description}</p>
          )}

          {/* Параметры пути и query */}
          {op.parameters && op.parameters.length > 0 && (
            <div className="space-y-2">
              <div className="font-semibold text-[11px] uppercase tracking-wider text-muted-foreground">
                Параметры запроса
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
                {op.parameters.map((p) => (
                  <div
                    key={p.name}
                    className="rounded border border-border bg-background p-2 space-y-1"
                  >
                    <div className="flex items-center justify-between gap-1">
                      <label className="font-mono font-semibold text-xs">
                        {p.name}
                        {p.required && <span className="text-destructive ml-0.5">*</span>}
                      </label>
                      <span className="text-[10px] font-mono uppercase text-muted-foreground">
                        {p.in} ({p.schema?.type || "string"})
                      </span>
                    </div>
                    {p.description && (
                      <div className="text-[11px] text-muted-foreground leading-snug">
                        {p.description}
                      </div>
                    )}
                    <Input
                      data-testid={`param-${op.operationId}-${p.name}`}
                      value={paramValues[p.name] ?? ""}
                      onChange={(e) =>
                        setParamValues((prev) => ({ ...prev, [p.name]: e.target.value }))
                      }
                      placeholder={
                        p.schema?.example !== undefined ? String(p.schema.example) : p.name
                      }
                      className="h-7 font-mono text-xs"
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Тело запроса JSON */}
          {op.requestBody && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-[11px] uppercase tracking-wider text-muted-foreground">
                  Тело запроса (application/json)
                </span>
                {op.requestBody.content?.["application/json"]?.examples && (
                  <div className="flex items-center gap-1">
                    {Object.entries(op.requestBody.content["application/json"].examples).map(
                      ([exKey, exVal]) => (
                        <Button
                          key={exKey}
                          type="button"
                          variant="outline"
                          size="xs"
                          onClick={() => setBodyText(JSON.stringify(exVal.value, null, 2))}
                        >
                          Пример: {exVal.summary || exKey}
                        </Button>
                      )
                    )}
                  </div>
                )}
              </div>
              <textarea
                data-testid={`body-${op.operationId}`}
                value={bodyText}
                onChange={(e) => setBodyText(e.target.value)}
                rows={5}
                className="w-full rounded-md border border-border bg-background p-2.5 font-mono text-xs"
              />
            </div>
          )}

          {/* Выполнение запроса и строка URL */}
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <div className="font-mono text-[11px] text-muted-foreground truncate">
              Запрос: <strong className="text-foreground">{method} {resolvedUrl}</strong>
            </div>
            <Button
              type="button"
              size="sm"
              onClick={handleExecute}
              disabled={executing}
              data-testid={`execute-${op.operationId}`}
            >
              <Play className="size-3.5" />
              {executing ? "Выполнение..." : "Выполнить запрос"}
            </Button>
          </div>

          {/* Ответ сервера */}
          {responseState && (
            <div className="space-y-1.5 pt-1">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-mono">
                  Статус:{" "}
                  <strong
                    className={
                      responseState.status >= 200 && responseState.status < 300
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-rose-600 dark:text-rose-400"
                    }
                  >
                    HTTP {responseState.status}
                  </strong>{" "}
                  ({responseState.durationMs} мс)
                </span>
              </div>
              <pre
                data-testid={`response-${op.operationId}`}
                className="max-h-80 overflow-auto rounded-md border border-border bg-background p-3 font-mono text-[11px] whitespace-pre-wrap"
              >
                {responseState.data}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
