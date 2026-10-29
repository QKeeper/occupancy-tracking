import React, { useState, useEffect, useRef } from "react";
import {
  User,
  TimelineGroup,
  ScheduleConfig,
  TimelineStyleConfig,
  TimeSlot,
  DayWeeklySchedule,
} from "@/types";
import {
  DEFAULT_SCHEDULE_TIMEZONE,
  convertScheduleConfigTimeZone,
  formatTimeZoneShort,
  getUserTimelineGroups,
  normalizeTimeZone,
} from "@/lib/schedule-engine";
import {
  DEFAULT_TIMELINE_STYLE,
  MAX_ICON_HISTORY,
  TELEGRAM_PATTERN_SYMBOLS,
  TintedPatternIcon,
  getTimelineBlockStyle,
} from "@/lib/timeline-pattern";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { TimeInput24 } from "@/components/ui/time-input-24";
import {
  Plus,
  Trash2,
  Layers,
  Sparkles,
  Upload,
  Calendar,
  Palette,
  Check,
  Moon,
  Briefcase,
  Dumbbell,
  BookOpen,
} from "lucide-react";
import { toast } from "sonner";

interface TimelineGroupsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: User;
  onSaveUser: (updated: Partial<User>) => Promise<void>;
}

const DAYS_OF_WEEK = [
  { key: "1", label: "Понедельник" },
  { key: "2", label: "Вторник" },
  { key: "3", label: "Среда" },
  { key: "4", label: "Четверг" },
  { key: "5", label: "Пятница" },
  { key: "6", label: "Суббота" },
  { key: "0", label: "Воскресенье" },
];

const COLOR_PRESETS = [
  { label: "Алый", bg: "#e11d48", pattern: "#fda4af" },
  { label: "Ночной индиго", bg: "#1e293b", pattern: "#94a3b8" },
  { label: "Изумруд", bg: "#059669", pattern: "#a7f3d0" },
  { label: "Янтарь", bg: "#d97706", pattern: "#fde68a" },
  { label: "Фиолетовый", bg: "#7c3aed", pattern: "#ddd6fe" },
  { label: "Лазурный", bg: "#0284c7", pattern: "#bae6fd" },
  { label: "Розовый", bg: "#db2777", pattern: "#fbcfe8" },
  { label: "Графит", bg: "#334155", pattern: "#cbd5e1" },
];

const EXTENDED_SYMBOLS = [
  ...TELEGRAM_PATTERN_SYMBOLS,
  "💤",
  "☕",
  "💻",
  "🏃",
  "📚",
  "🎨",
  "🍿",
];

function buildDefaultWeekly(
  defaultSlots: TimeSlot[] = [{ start: "09:00", end: "18:00" }],
  allDays = false
): Record<string, DayWeeklySchedule> {
  const weekly: Record<string, DayWeeklySchedule> = {};
  for (const d of ["1", "2", "3", "4", "5", "6", "0"]) {
    const isWork = allDays || !["6", "0"].includes(d);
    weekly[d] = {
      isWorking: isWork,
      slots: isWork ? defaultSlots.map((s) => ({ ...s })) : [],
    };
  }
  return weekly;
}

export const TimelineGroupsModal: React.FC<TimelineGroupsModalProps> = ({
  open,
  onOpenChange,
  user,
  onSaveUser,
}) => {
  const [groups, setGroups] = useState<TimelineGroup[]>(() => getUserTimelineGroups(user));
  const [selectedGroupId, setSelectedGroupId] = useState<string>("work");
  const [saving, setSaving] = useState(false);
  const [showNewGroupMenu, setShowNewGroupMenu] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const customIconInputRef = useRef<HTMLInputElement>(null);

  const userTz = normalizeTimeZone(user.time_zone || DEFAULT_SCHEDULE_TIMEZONE);

  useEffect(() => {
    if (open) {
      const initialGroups = getUserTimelineGroups(user);
      setGroups(initialGroups);
      if (!initialGroups.some((g) => g.id === selectedGroupId)) {
        setSelectedGroupId(initialGroups[0]?.id || "work");
      }
      setShowNewGroupMenu(false);
      setNewGroupName("");
    }
  }, [open, user.id, user.revision]);

  const activeGroup = groups.find((g) => g.id === selectedGroupId) || groups[0];

  const updateActiveGroup = (updater: (prev: TimelineGroup) => TimelineGroup) => {
    setGroups((prev) =>
      prev.map((g) => (g.id === selectedGroupId ? updater(g) : g))
    );
  };

  const handleToggleGroupEnabled = (id: string, enabled: boolean) => {
    setGroups((prev) =>
      prev.map((g) => (g.id === id ? { ...g, is_enabled: enabled } : g))
    );
  };

  const handleDeleteGroup = (id: string) => {
    if (groups.length <= 1) {
      toast.error("Нельзя удалить единственную группу таймлайнов");
      return;
    }
    const filtered = groups.filter((g) => g.id !== id);
    setGroups(filtered);
    if (selectedGroupId === id) {
      setSelectedGroupId(filtered[0].id);
    }
    toast.success("Группа удалена");
  };

  const handleCreateCustomGroup = () => {
    const trimmed = newGroupName.trim();
    if (!trimmed) {
      toast.error("Введите название группы");
      return;
    }
    const id = `group_${Date.now()}`;
    const newGroup: TimelineGroup = {
      id,
      name: trimmed,
      style: {
        bgColor: "#2563eb",
        patternColor: "#bfdbfe",
        patternType: "stripes",
        symbol: "⚡",
        iconScale: 1,
        iconHistory: [...TELEGRAM_PATTERN_SYMBOLS],
      },
      schedule_config: {
        mode: "fixed_weekly",
        timeZone: userTz,
        weekly: buildDefaultWeekly([{ start: "10:00", end: "19:00" }], false),
      },
      overrides: {},
      is_enabled: true,
    };

    setGroups((prev) => [...prev, newGroup]);
    setSelectedGroupId(id);
    setNewGroupName("");
    setShowNewGroupMenu(false);
    toast.success(`Группа «${trimmed}» создана`);
  };

  // Schedule helpers for active group
  const activeSched = activeGroup?.schedule_config || { mode: "fixed_weekly" };

  const handleToggleWeeklyDay = (dayKey: string, checked: boolean) => {
    updateActiveGroup((g) => {
      const weekly = {
        ...(g.schedule_config.weekly || buildDefaultWeekly()),
      };
      const existing = weekly[dayKey]?.slots || [];
      const fallbackSlot = g.id === "sleep" ? { start: "23:00", end: "07:00" } : { start: "09:00", end: "18:00" };
      weekly[dayKey] = {
        isWorking: checked,
        slots: checked && existing.length === 0 ? [fallbackSlot] : existing,
      };
      return {
        ...g,
        schedule_config: { ...g.schedule_config, weekly },
      };
    });
  };

  const handleSlotChange = (dayKey: string, index: number, field: "start" | "end", val: string) => {
    updateActiveGroup((g) => {
      const weekly = { ...(g.schedule_config.weekly || buildDefaultWeekly()) };
      const daySlots = [...(weekly[dayKey]?.slots || [])];
      daySlots[index] = { ...daySlots[index], [field]: val };
      weekly[dayKey] = { ...weekly[dayKey], slots: daySlots };
      return {
        ...g,
        schedule_config: { ...g.schedule_config, weekly },
      };
    });
  };

  const handleAddSlot = (dayKey: string) => {
    updateActiveGroup((g) => {
      const weekly = { ...(g.schedule_config.weekly || buildDefaultWeekly()) };
      const daySlots = [...(weekly[dayKey]?.slots || [])];
      daySlots.push({ start: "14:00", end: "18:00" });
      weekly[dayKey] = { isWorking: true, slots: daySlots };
      return {
        ...g,
        schedule_config: { ...g.schedule_config, weekly },
      };
    });
  };

  const handleRemoveSlot = (dayKey: string, index: number) => {
    updateActiveGroup((g) => {
      const weekly = { ...(g.schedule_config.weekly || buildDefaultWeekly()) };
      const daySlots = (weekly[dayKey]?.slots || []).filter((_, i) => i !== index);
      weekly[dayKey] = {
        isWorking: daySlots.length > 0,
        slots: daySlots,
      };
      return {
        ...g,
        schedule_config: { ...g.schedule_config, weekly },
      };
    });
  };

  const handleCopyToAllDays = (sourceDayKey: string) => {
    updateActiveGroup((g) => {
      const weekly = { ...(g.schedule_config.weekly || buildDefaultWeekly()) };
      const sourceDay = weekly[sourceDayKey];
      if (!sourceDay) return g;
      const nextWeekly: Record<string, DayWeeklySchedule> = {};
      for (const d of ["1", "2", "3", "4", "5", "6", "0"]) {
        nextWeekly[d] = {
          isWorking: sourceDay.isWorking,
          slots: sourceDay.slots.map((s) => ({ ...s })),
        };
      }
      return {
        ...g,
        schedule_config: { ...g.schedule_config, weekly: nextWeekly },
      };
    });
    toast.success("Расписание скопировано на все дни");
  };

  // Custom icon upload for group style
  const handleCustomIconUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    try {
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const dataUrl = String(reader.result);
          const res = await fetch("/api/upload", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ dataUrl, kind: "icon" }),
          });
          const json = await res.json();
          if (!res.ok) throw new Error(json.error || "Ошибка загрузки");

          updateActiveGroup((g) => ({
            ...g,
            style: {
              ...g.style,
              patternType: "symbols",
              symbol: json.url,
              iconHistory: [json.url, ...(g.style.iconHistory || []).filter((s) => s !== json.url)].slice(
                0,
                MAX_ICON_HISTORY
              ),
            },
          }));
          toast.success("Иконка загружена");
        } catch (err: any) {
          toast.error(err.message || "Ошибка сохранения иконки");
        }
      };
      reader.readAsDataURL(file);
    } catch (err: any) {
      toast.error(err.message || "Ошибка чтения файла");
    }
  };

  const handleSaveAll = async () => {
    setSaving(true);
    try {
      const workGroup = groups.find((g) => g.id === "work");
      await onSaveUser({
        timeline_groups: groups,
        ...(workGroup
          ? {
              schedule_config: workGroup.schedule_config,
              timeline_style: workGroup.style,
            }
          : {}),
      });
      toast.success("Группы таймлайнов сохранены");
      onOpenChange(false);
    } catch (e: any) {
      toast.error(e.message || "Не удалось сохранить");
    } finally {
      setSaving(false);
    }
  };

  if (!activeGroup) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl md:max-w-5xl lg:max-w-[1060px] w-[95vw] h-[88vh] max-h-[850px] flex flex-col p-0 overflow-hidden">
        <DialogHeader className="px-6 pt-5 pb-3 border-b border-border/80">
          <div className="flex items-center justify-between">
            <div>
              <DialogTitle className="text-lg font-semibold flex items-center gap-2">
                <Layers className="size-5 text-primary" />
                <span>Группы таймлайнов</span>
              </DialogTitle>
              <DialogDescription className="text-xs text-muted-foreground mt-0.5">
                Настройте расписание и уникальный скин для каждой группы (график работы, сон, спорт и др.)
              </DialogDescription>
            </div>
            <div className="text-xs text-muted-foreground font-mono bg-muted/40 px-2 py-1 rounded">
              {formatTimeZoneShort(userTz)}
            </div>
          </div>
        </DialogHeader>

        <div className="flex-1 min-h-0 flex overflow-hidden">
          {/* ЛЕВАЯ КОЛОНКА: СПИСОК ГРУПП ТАЙМЛАЙНОВ */}
          <div className="w-72 border-r border-border/70 bg-muted/20 flex flex-col p-3.5 space-y-2.5 shrink-0 overflow-y-auto">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground px-1 flex items-center justify-between">
              <span>Ваши группы</span>
              <span className="text-xs font-mono">{groups.length}</span>
            </div>

            <div className="space-y-1.5 flex-1">
              {groups.map((group) => {
                const isSelected = group.id === selectedGroupId;
                return (
                  <div
                    key={group.id}
                    onClick={() => setSelectedGroupId(group.id)}
                    className={`group/item flex items-center justify-between p-2 rounded-lg border text-xs cursor-pointer transition-all ${
                      isSelected
                        ? "border-primary bg-primary/10 text-foreground font-medium shadow-xs"
                        : "border-border/60 bg-card hover:bg-muted/50 text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className="size-3 rounded-full border border-white/20 shrink-0"
                        style={{ backgroundColor: group.style.bgColor }}
                      />
                      <span className="truncate">{group.name}</span>
                    </div>

                    <div className="flex items-center gap-1 shrink-0">
                      <Switch
                        checked={group.is_enabled !== false}
                        onCheckedChange={(checked) => handleToggleGroupEnabled(group.id, checked)}
                        onClick={(e) => e.stopPropagation()}
                        className="scale-75"
                        title={group.is_enabled !== false ? "Включена" : "Отключена"}
                      />
                      {groups.length > 1 && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteGroup(group.id);
                          }}
                          className="opacity-0 group-hover/item:opacity-100 hover:text-destructive p-1 rounded transition-opacity"
                          title="Удалить группу"
                        >
                          <Trash2 className="size-3" />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Кнопка создания группы */}
            <div className="pt-2 border-t border-border/60">
              {showNewGroupMenu ? (
                <div className="space-y-2 p-2 bg-card rounded-lg border border-border shadow-xs">
                  <div className="text-[11px] font-semibold text-foreground">Новая группа</div>
                  <Input
                    placeholder="Название группы..."
                    value={newGroupName}
                    onChange={(e) => setNewGroupName(e.target.value)}
                    className="h-7 text-xs"
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleCreateCustomGroup();
                    }}
                  />
                  <div className="flex items-center gap-1">
                    <Button
                      size="sm"
                      className="h-7 text-xs flex-1"
                      onClick={handleCreateCustomGroup}
                    >
                      Создать
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs"
                      onClick={() => setShowNewGroupMenu(false)}
                    >
                      Отмена
                    </Button>
                  </div>

                  </div>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowNewGroupMenu(true)}
                  className="w-full text-xs h-8 justify-center gap-1.5"
                >
                  <Plus className="size-3.5" />
                  <span>Создать группу</span>
                </Button>
              )}
            </div>
          </div>

          {/* ПРАВАЯ КОЛОНКА: РЕДАКТОР ВЫБРАННОЙ ГРУППЫ */}
          <div className="flex-1 min-w-0 flex flex-col overflow-y-auto p-6 space-y-5">
            {/* Заголовок группы и переименование */}
            <div className="flex items-center justify-between gap-4 pb-3 border-b border-border/60">
              <div className="flex-1 max-w-sm">
                <Label className="text-[11px] text-muted-foreground">Название группы</Label>
                <Input
                  value={activeGroup.name}
                  onChange={(e) =>
                    updateActiveGroup((g) => ({ ...g, name: e.target.value }))
                  }
                  className="h-8 font-medium mt-1 text-sm"
                  placeholder="Название группы..."
                />
              </div>

              <div className="flex items-center gap-2">
                <Label htmlFor="active-toggle" className="text-xs cursor-pointer">
                  {activeGroup.is_enabled !== false ? "Отображается на таймлайне" : "Скрыта"}
                </Label>
                <Switch
                  id="active-toggle"
                  checked={activeGroup.is_enabled !== false}
                  onCheckedChange={(checked) =>
                    updateActiveGroup((g) => ({ ...g, is_enabled: checked }))
                  }
                />
              </div>
            </div>

            {/* Вкладки: Расписание vs Скин таймлайна */}
            <Tabs defaultValue="schedule" className="flex-1 flex flex-col space-y-4">
              <TabsList className="grid grid-cols-2 w-full max-w-md">
                <TabsTrigger value="schedule" className="text-xs flex items-center gap-1.5">
                  <Calendar className="size-3.5" />
                  <span>Расписание</span>
                </TabsTrigger>
                <TabsTrigger value="skin" className="text-xs flex items-center gap-1.5">
                  <Palette className="size-3.5" />
                  <span>Скин таймлайна</span>
                </TabsTrigger>
              </TabsList>

              {/* ВКЛАДКА 1: РАСПИСАНИЕ ГРУППЫ */}
              <TabsContent value="schedule" className="space-y-4 mt-0">
                {/* Режим расписания */}
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-muted-foreground">Режим:</span>
                  <div className="inline-flex rounded-lg border border-border p-0.5 bg-muted/40">
                    <button
                      type="button"
                      onClick={() =>
                        updateActiveGroup((g) => ({
                          ...g,
                          schedule_config: {
                            ...g.schedule_config,
                            mode: "fixed_weekly",
                            weekly: g.schedule_config.weekly || buildDefaultWeekly(),
                          },
                        }))
                      }
                      className={`px-3 py-1 rounded-md text-xs font-medium transition-all ${
                        activeSched.mode === "fixed_weekly"
                          ? "bg-background text-foreground shadow-xs"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      Недельный график
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        updateActiveGroup((g) => ({
                          ...g,
                          schedule_config: {
                            ...g.schedule_config,
                            mode: "shift_cycle",
                            shift: g.schedule_config.shift || {
                              workDays: 2,
                              offDays: 2,
                              startDate: new Date().toISOString().slice(0, 10),
                              slots: [{ start: "09:00", end: "21:00" }],
                            },
                          },
                        }))
                      }
                      className={`px-3 py-1 rounded-md text-xs font-medium transition-all ${
                        activeSched.mode === "shift_cycle"
                          ? "bg-background text-foreground shadow-xs"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      Сменный цикл (2/2, 3/3)
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        updateActiveGroup((g) => ({
                          ...g,
                          schedule_config: {
                            ...g.schedule_config,
                            mode: "manual",
                          },
                        }))
                      }
                      className={`px-3 py-1 rounded-md text-xs font-medium transition-all ${
                        activeSched.mode === "manual"
                          ? "bg-background text-foreground shadow-xs"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      Свободный / Ручной
                    </button>
                  </div>
                </div>

                {/* НЕДЕЛЬНЫЙ ГРАФИК */}
                {activeSched.mode === "fixed_weekly" && (
                  <div className="space-y-2.5">
                    {DAYS_OF_WEEK.map(({ key, label }) => {
                      const dayConfig = activeSched.weekly?.[key] || {
                        isWorking: false,
                        slots: [],
                      };
                      return (
                        <div
                          key={key}
                          className={`p-3 rounded-lg border min-h-[58px] flex flex-col justify-center transition-colors ${
                            dayConfig.isWorking
                              ? "border-border bg-card/80"
                              : "border-border/40 bg-muted/15 opacity-70"
                          }`}
                        >
                          <div className="flex items-start justify-between gap-3 min-h-[32px]">
                            <div className="flex items-center gap-3 h-8">
                              <Switch
                                checked={dayConfig.isWorking}
                                onCheckedChange={(checked) => handleToggleWeeklyDay(key, checked)}
                              />
                              <span className="text-xs font-medium text-foreground w-28">
                                {label}
                              </span>
                            </div>

                            {dayConfig.isWorking && (
                              <div className="flex items-start gap-2">
                                <div className="flex flex-col gap-1.5">
                                  {dayConfig.slots.map((slot, idx) => (
                                    <div key={idx} className="flex items-center gap-1.5">
                                      <TimeInput24
                                        value={slot.start}
                                        onChange={(v) => handleSlotChange(key, idx, "start", v)}
                                      />
                                      <span className="text-muted-foreground text-xs">–</span>
                                      <TimeInput24
                                        value={slot.end}
                                        onChange={(v) => handleSlotChange(key, idx, "end", v)}
                                      />
                                      {dayConfig.slots.length > 1 && (
                                        <button
                                          type="button"
                                          onClick={() => handleRemoveSlot(key, idx)}
                                          className="text-muted-foreground hover:text-destructive p-1 rounded transition-colors"
                                          title="Удалить слот"
                                        >
                                          <Trash2 className="size-3" />
                                        </button>
                                      )}
                                    </div>
                                  ))}
                                </div>

                                <div className="flex items-center gap-1 self-start">
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => handleAddSlot(key)}
                                    className="h-8 px-2 text-[11px]"
                                  >
                                    <Plus className="size-3 mr-1" />
                                    Слот
                                  </Button>

                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => handleCopyToAllDays(key)}
                                    className="h-8 px-2 text-[10px] text-muted-foreground hover:text-foreground"
                                    title="Скопировать этот график на все дни недели"
                                  >
                                    На все дни
                                  </Button>
                                </div>
                              </div>
                            )}

                            {!dayConfig.isWorking && (
                              <div className="flex items-center h-8">
                                <span className="text-xs text-muted-foreground italic">
                                  Выходной
                                </span>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* СМЕННЫЙ ГРАФИК */}
                {activeSched.mode === "shift_cycle" && (
                  <div className="space-y-3 p-4 rounded-lg border border-border bg-card">
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <Label className="text-xs">Дней работы</Label>
                        <Input
                          type="number"
                          min={1}
                          max={30}
                          value={activeSched.shift?.workDays || 2}
                          onChange={(e) =>
                            updateActiveGroup((g) => ({
                              ...g,
                              schedule_config: {
                                ...g.schedule_config,
                                shift: {
                                  ...(g.schedule_config.shift || {
                                    workDays: 2,
                                    offDays: 2,
                                    startDate: new Date().toISOString().slice(0, 10),
                                    slots: [{ start: "09:00", end: "21:00" }],
                                  }),
                                  workDays: Math.max(1, parseInt(e.target.value, 10) || 1),
                                },
                              },
                            }))
                          }
                          className="h-8 text-xs mt-1"
                        />
                      </div>
                      <div>
                        <Label className="text-xs">Дней отдыха</Label>
                        <Input
                          type="number"
                          min={0}
                          max={30}
                          value={activeSched.shift?.offDays || 2}
                          onChange={(e) =>
                            updateActiveGroup((g) => ({
                              ...g,
                              schedule_config: {
                                ...g.schedule_config,
                                shift: {
                                  ...(g.schedule_config.shift || {
                                    workDays: 2,
                                    offDays: 2,
                                    startDate: new Date().toISOString().slice(0, 10),
                                    slots: [{ start: "09:00", end: "21:00" }],
                                  }),
                                  offDays: Math.max(0, parseInt(e.target.value, 10) || 0),
                                },
                              },
                            }))
                          }
                          className="h-8 text-xs mt-1"
                        />
                      </div>
                    </div>

                    <div>
                      <Label className="text-xs">Дата начала первого рабочего дня цикла</Label>
                      <Input
                        type="date"
                        value={activeSched.shift?.startDate || new Date().toISOString().slice(0, 10)}
                        onChange={(e) =>
                          updateActiveGroup((g) => ({
                            ...g,
                            schedule_config: {
                              ...g.schedule_config,
                              shift: {
                                ...(g.schedule_config.shift || {
                                  workDays: 2,
                                  offDays: 2,
                                  startDate: new Date().toISOString().slice(0, 10),
                                  slots: [{ start: "09:00", end: "21:00" }],
                                }),
                                startDate: e.target.value,
                              },
                            },
                          }))
                        }
                        className="h-8 text-xs mt-1"
                      />
                    </div>

                    <div>
                      <Label className="text-xs">Часы смены</Label>
                      <div className="flex items-center gap-2 mt-1">
                        <TimeInput24
                          value={activeSched.shift?.slots?.[0]?.start || "09:00"}
                          onChange={(val) =>
                            updateActiveGroup((g) => {
                              const slots = [...(g.schedule_config.shift?.slots || [{ start: "09:00", end: "21:00" }])];
                              slots[0] = { ...slots[0], start: val };
                              return {
                                ...g,
                                schedule_config: {
                                  ...g.schedule_config,
                                  shift: { ...g.schedule_config.shift!, slots },
                                },
                              };
                            })
                          }
                        />
                        <span className="text-muted-foreground">–</span>
                        <TimeInput24
                          value={activeSched.shift?.slots?.[0]?.end || "21:00"}
                          onChange={(val) =>
                            updateActiveGroup((g) => {
                              const slots = [...(g.schedule_config.shift?.slots || [{ start: "09:00", end: "21:00" }])];
                              slots[0] = { ...slots[0], end: val };
                              return {
                                ...g,
                                schedule_config: {
                                  ...g.schedule_config,
                                  shift: { ...g.schedule_config.shift!, slots },
                                },
                              };
                            })
                          }
                        />
                      </div>
                    </div>
                  </div>
                )}
              </TabsContent>

              {/* ВКЛАДКА 2: СКИН ТАЙМЛАЙНА ДЛЯ ЭТОЙ ГРУППЫ */}
              <TabsContent value="skin" className="space-y-4 mt-0">
                {/* Предпросмотр */}
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Предпросмотр диапазона на таймлайне</Label>
                  <div className="relative h-12 rounded-lg border border-border bg-background/60 overflow-hidden flex items-center px-4">
                    <div
                      style={getTimelineBlockStyle(activeGroup.style)}
                      className="h-full w-full border-x flex items-center gap-2 px-3 text-white shadow-xs"
                    >
                      <span className="text-[11px] font-mono font-medium drop-shadow-xs shrink-0">
                        {activeGroup.id === "sleep" ? "23:00" : "09:00"}
                      </span>
                      <span className="text-[11px] font-medium truncate drop-shadow-xs">
                        {activeGroup.name}
                      </span>
                      <span className="ml-auto text-[11px] font-mono font-medium drop-shadow-xs shrink-0">
                        {activeGroup.id === "sleep" ? "07:00" : "18:00"}
                      </span>
                    </div>
                  </div>
                </div>

                {/* 2 пикера цвета */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label className="text-xs">Цвет фона</Label>
                    <div className="flex items-center gap-2 rounded-lg border border-border bg-background/50 p-1.5">
                      <input
                        type="color"
                        value={activeGroup.style.bgColor}
                        onChange={(e) =>
                          updateActiveGroup((g) => ({
                            ...g,
                            style: { ...g.style, bgColor: e.target.value },
                          }))
                        }
                        className="size-6 rounded cursor-pointer border-0 bg-transparent"
                      />
                      <span className="text-xs font-mono uppercase">
                        {activeGroup.style.bgColor}
                      </span>
                    </div>
                  </div>

                  <div className="space-y-1">
                    <Label className="text-xs">Цвет паттерна</Label>
                    <div className="flex items-center gap-2 rounded-lg border border-border bg-background/50 p-1.5">
                      <input
                        type="color"
                        value={activeGroup.style.patternColor}
                        onChange={(e) =>
                          updateActiveGroup((g) => ({
                            ...g,
                            style: { ...g.style, patternColor: e.target.value },
                          }))
                        }
                        className="size-6 rounded cursor-pointer border-0 bg-transparent"
                      />
                      <span className="text-xs font-mono uppercase">
                        {activeGroup.style.patternColor}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Пресеты цветовых пар */}
                <div className="flex flex-wrap gap-1.5">
                  {COLOR_PRESETS.map((preset) => (
                    <button
                      key={preset.label}
                      type="button"
                      onClick={() =>
                        updateActiveGroup((g) => ({
                          ...g,
                          style: {
                            ...g.style,
                            bgColor: preset.bg,
                            patternColor: preset.pattern,
                          },
                        }))
                      }
                      className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md border border-border bg-muted/30 hover:bg-muted text-[11px] cursor-pointer"
                    >
                      <span
                        className="size-3 rounded-full border border-white/30"
                        style={{ backgroundColor: preset.bg }}
                      />
                      <span>{preset.label}</span>
                    </button>
                  ))}
                </div>

                {/* Тип узора */}
                <div className="space-y-1">
                  <Label className="text-xs">Тип узора</Label>
                  <div className="grid grid-cols-3 gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        updateActiveGroup((g) => ({
                          ...g,
                          style: { ...g.style, patternType: "stripes" },
                        }))
                      }
                      className={`p-2 rounded-lg border text-xs font-medium cursor-pointer ${
                        activeGroup.style.patternType === "stripes"
                          ? "border-primary bg-primary/10 text-foreground"
                          : "border-border bg-background/40 text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      Полосочка
                    </button>

                    <button
                      type="button"
                      onClick={() =>
                        updateActiveGroup((g) => ({
                          ...g,
                          style: { ...g.style, patternType: "symbols" },
                        }))
                      }
                      className={`p-2 rounded-lg border text-xs font-medium cursor-pointer flex items-center justify-center gap-1 ${
                        activeGroup.style.patternType === "symbols"
                          ? "border-primary bg-primary/10 text-foreground"
                          : "border-border bg-background/40 text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      <Sparkles className="size-3" />
                      <span>Иконки</span>
                    </button>

                    <button
                      type="button"
                      onClick={() =>
                        updateActiveGroup((g) => ({
                          ...g,
                          style: { ...g.style, patternType: "none" },
                        }))
                      }
                      className={`p-2 rounded-lg border text-xs font-medium cursor-pointer ${
                        activeGroup.style.patternType === "none"
                          ? "border-primary bg-primary/10 text-foreground"
                          : "border-border bg-background/40 text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      Сплошной
                    </button>
                  </div>
                </div>

                {/* Выбор иконок */}
                {activeGroup.style.patternType === "symbols" && (
                  <div className="space-y-2.5 rounded-lg border border-border bg-muted/20 p-2.5">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-[11px] font-medium text-muted-foreground">
                        Масштаб иконки ({Math.round((activeGroup.style.iconScale ?? 1) * 100)}%)
                      </span>
                      <input
                        type="range"
                        min="0.5"
                        max="2.0"
                        step="0.05"
                        value={activeGroup.style.iconScale ?? 1}
                        onChange={(e) =>
                          updateActiveGroup((g) => ({
                            ...g,
                            style: { ...g.style, iconScale: parseFloat(e.target.value) },
                          }))
                        }
                        className="w-32 h-1 accent-primary"
                      />
                    </div>

                    <div className="grid grid-cols-8 gap-1.5 pt-1">
                      {/* Слот загрузки */}
                      <button
                        type="button"
                        onClick={() => customIconInputRef.current?.click()}
                        className="aspect-square rounded-md border border-dashed border-border hover:border-primary flex flex-col items-center justify-center text-[9px] text-muted-foreground hover:text-foreground"
                        title="Загрузить SVG или PNG иконку"
                      >
                        <Upload className="size-3.5" />
                      </button>
                      <input
                        ref={customIconInputRef}
                        type="file"
                        accept="image/svg+xml,image/png,image/webp"
                        className="hidden"
                        onChange={handleCustomIconUpload}
                      />

                      {/* Сетка готовых символов */}
                      {EXTENDED_SYMBOLS.map((sym) => {
                        const isChosen = activeGroup.style.symbol === sym;
                        return (
                          <button
                            key={sym}
                            type="button"
                            onClick={() =>
                              updateActiveGroup((g) => ({
                                ...g,
                                style: {
                                  ...g.style,
                                  symbol: sym,
                                  iconHistory: [
                                    sym,
                                    ...(g.style.iconHistory || []).filter((s) => s !== sym),
                                  ].slice(0, MAX_ICON_HISTORY),
                                },
                              }))
                            }
                            className={`aspect-square rounded-md border flex items-center justify-center transition-all ${
                              isChosen
                                ? "border-primary bg-primary/20 ring-1 ring-primary/60 scale-105"
                                : "border-border/60 bg-background/50 hover:bg-muted"
                            }`}
                          >
                            <TintedPatternIcon
                              symbol={sym}
                              color={activeGroup.style.patternColor}
                              size={16}
                            />
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </TabsContent>
            </Tabs>
          </div>
        </div>

        <DialogFooter className="m-0 mx-0 mb-0 mt-0 w-full rounded-b-xl px-6 py-3 border-t border-border/80 flex items-center justify-between shrink-0 bg-background">
          <div className="text-xs text-muted-foreground">
            Всего групп: <span className="font-semibold text-foreground">{groups.length}</span> (активных:{" "}
            {groups.filter((g) => g.is_enabled !== false).length})
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              Отмена
            </Button>
            <Button size="sm" onClick={handleSaveAll} disabled={saving}>
              Сохранить все группы
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
