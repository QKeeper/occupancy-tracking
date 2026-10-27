import React, { useState } from "react";
import { User, ScheduleConfig, TimeSlot, DayWeeklySchedule } from "@/types";
import {
  DEFAULT_SCHEDULE_TIMEZONE,
  convertScheduleConfigTimeZone,
  formatTimeZoneShort,
  normalizeTimeZone,
} from "@/lib/schedule-engine";
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
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

interface ScheduleProfileModalProps {
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

export const ScheduleProfileModal: React.FC<ScheduleProfileModalProps> = ({
  open,
  onOpenChange,
  user,
  onSaveUser,
}) => {
  const [saving, setSaving] = useState(false);
  const [editRevision, setEditRevision] = useState(user.revision);

  const defaultWeekly: Record<string, DayWeeklySchedule> = {
    "1": { isWorking: true, slots: [{ start: "09:00", end: "18:00" }] },
    "2": { isWorking: true, slots: [{ start: "09:00", end: "18:00" }] },
    "3": { isWorking: true, slots: [{ start: "09:00", end: "18:00" }] },
    "4": { isWorking: true, slots: [{ start: "09:00", end: "18:00" }] },
    "5": { isWorking: true, slots: [{ start: "09:00", end: "18:00" }] },
    "6": { isWorking: false, slots: [] },
    "0": { isWorking: false, slots: [] },
  };

  const defaultShift = {
    workDays: 2,
    offDays: 2,
    startDate: new Date().toISOString().slice(0, 10),
    slots: [{ start: "09:00", end: "21:00" }],
  };

  const userTz = normalizeTimeZone(user.time_zone || DEFAULT_SCHEDULE_TIMEZONE);

  const buildInitialConfig = (): ScheduleConfig => {
    const base: ScheduleConfig = {
      mode: user.schedule_config?.mode || "fixed_weekly",
      timeZone: user.schedule_config?.timeZone || DEFAULT_SCHEDULE_TIMEZONE,
      weekly: { ...defaultWeekly, ...(user.schedule_config?.weekly || {}) },
      shift: { ...defaultShift, ...(user.schedule_config?.shift || {}) },
    };
    return convertScheduleConfigTimeZone(base, userTz);
  };

  const [config, setConfig] = useState<ScheduleConfig>(buildInitialConfig);

  React.useEffect(() => {
    if (open) {
      setEditRevision(user.revision);
      setConfig(buildInitialConfig());
    }
  }, [open, user.id, user.time_zone, user.revision]);

  const handleToggleWeeklyDay = (dayKey: string, checked: boolean) => {
    setConfig((prev) => {
      const weekly = { ...(prev.weekly || defaultWeekly) };
      const existingSlots = weekly[dayKey]?.slots || [];
      weekly[dayKey] = {
        isWorking: checked,
        slots:
          checked && existingSlots.length === 0
            ? [{ start: "09:00", end: "18:00" }]
            : existingSlots,
      };
      return { ...prev, weekly };
    });
  };

  const handleWeeklySlotChange = (
    dayKey: string,
    idx: number,
    field: keyof TimeSlot,
    val: string
  ) => {
    setConfig((prev) => {
      const weekly = { ...(prev.weekly || defaultWeekly) };
      const slots = [...(weekly[dayKey]?.slots || [])];
      slots[idx] = { ...slots[idx], [field]: val };
      weekly[dayKey] = { ...weekly[dayKey], slots };
      return { ...prev, weekly };
    });
  };

  const handleAddWeeklySlot = (dayKey: string) => {
    setConfig((prev) => {
      const weekly = { ...(prev.weekly || defaultWeekly) };
      const slots = [
        ...(weekly[dayKey]?.slots || []),
        { start: "14:00", end: "18:00" },
      ];
      weekly[dayKey] = { isWorking: true, slots };
      return { ...prev, weekly };
    });
  };

  const handleRemoveWeeklySlot = (dayKey: string, idx: number) => {
    setConfig((prev) => {
      const weekly = { ...(prev.weekly || defaultWeekly) };
      const slots = (weekly[dayKey]?.slots || []).filter((_, i) => i !== idx);
      weekly[dayKey] = {
        isWorking: slots.length > 0,
        slots,
      };
      return { ...prev, weekly };
    });
  };

  const applyPresetShift = (workDays: number, offDays: number, start: string, end: string) => {
    setConfig((prev) => ({
      ...prev,
      mode: "shift_cycle",
      shift: {
        workDays,
        offDays,
        startDate: prev.shift?.startDate || new Date().toISOString().slice(0, 10),
        slots: [{ start, end }],
      },
    }));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const nextConfig: ScheduleConfig = {
        ...config,
        ...(userTz !== DEFAULT_SCHEDULE_TIMEZONE || config.timeZone
          ? { timeZone: userTz }
          : {}),
      };
      await onSaveUser({
        revision: editRevision,
        schedule_config: nextConfig,
      });
      toast.success("График сохранён");
      onOpenChange(false);
    } catch (e: any) {
      toast.error(e.message || "Ошибка сохранения");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Мой график работы (@{user.username})</DialogTitle>
          <DialogDescription className="text-xs">
            Часовой пояс: {formatTimeZoneShort(userTz)} ({userTz})
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">

          <Tabs
            value={config.mode}
            onValueChange={(v) =>
              setConfig((prev) => ({
                ...prev,
                mode: v as ScheduleConfig["mode"],
              }))
            }
          >
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="fixed_weekly">Дни недели</TabsTrigger>
              <TabsTrigger value="shift_cycle">Сменный цикл</TabsTrigger>
              <TabsTrigger value="manual">Вручную</TabsTrigger>
            </TabsList>

            <TabsContent value="fixed_weekly" className="space-y-2 pt-2">
              <div className="space-y-1.5 max-h-[300px] overflow-y-auto pr-1">
                {DAYS_OF_WEEK.map(({ key, label }) => {
                  const dayData = config.weekly?.[key] || { isWorking: false, slots: [] };
                  return (
                    <div
                      key={key}
                      className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 p-2.5 rounded-md border border-border"
                    >
                      <div className="flex items-center gap-2.5 min-w-[140px]">
                        <Switch
                          checked={dayData.isWorking}
                          onCheckedChange={(chk) => handleToggleWeeklyDay(key, chk)}
                        />
                        <span className="text-sm font-medium">{label}</span>
                      </div>

                      {dayData.isWorking ? (
                        <div className="flex-1 space-y-1.5">
                          {dayData.slots.map((slot, sIdx) => (
                            <div key={sIdx} className="flex items-center gap-1.5 justify-end">
                              <TimeInput24
                                value={slot.start}
                                onChange={(val) =>
                                  handleWeeklySlotChange(key, sIdx, "start", val)
                                }
                              />
                              <span className="text-muted-foreground text-xs">–</span>
                              <TimeInput24
                                value={slot.end}
                                onChange={(val) =>
                                  handleWeeklySlotChange(key, sIdx, "end", val)
                                }
                              />
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                onClick={() => handleRemoveWeeklySlot(key, sIdx)}
                                className="size-8 text-muted-foreground hover:text-destructive"
                              >
                                <Trash2 className="size-3.5" />
                              </Button>
                            </div>
                          ))}
                          <div className="flex justify-end">
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => handleAddWeeklySlot(key)}
                              className="h-6 px-2 text-xs text-muted-foreground"
                            >
                              <Plus className="size-3 mr-1" />
                              Слот
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">Выходной</span>
                      )}
                    </div>
                  );
                })}
              </div>
            </TabsContent>

            <TabsContent value="shift_cycle" className="space-y-3 pt-2">
              <div className="flex flex-wrap gap-1.5">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => applyPresetShift(2, 2, "09:00", "21:00")}
                >
                  2/2
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => applyPresetShift(3, 3, "08:00", "20:00")}
                >
                  3/3
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => applyPresetShift(1, 3, "09:00", "09:00")}
                >
                  1/3
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => applyPresetShift(4, 2, "10:00", "19:00")}
                >
                  4/2
                </Button>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="shift-work">Рабочих дней</Label>
                  <Input
                    id="shift-work"
                    type="number"
                    min={1}
                    max={14}
                    value={config.shift?.workDays ?? 2}
                    onChange={(e) =>
                      setConfig((p) => ({
                        ...p,
                        shift: {
                          ...(p.shift || defaultShift),
                          workDays: Math.max(1, parseInt(e.target.value, 10) || 1),
                        },
                      }))
                    }
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="shift-off">Выходных дней</Label>
                  <Input
                    id="shift-off"
                    type="number"
                    min={1}
                    max={14}
                    value={config.shift?.offDays ?? 2}
                    onChange={(e) =>
                      setConfig((p) => ({
                        ...p,
                        shift: {
                          ...(p.shift || defaultShift),
                          offDays: Math.max(1, parseInt(e.target.value, 10) || 1),
                        },
                      }))
                    }
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="shift-start">Начало цикла</Label>
                  <Input
                    id="shift-start"
                    type="date"
                    value={config.shift?.startDate || ""}
                    onChange={(e) =>
                      setConfig((p) => ({
                        ...p,
                        shift: {
                          ...(p.shift || defaultShift),
                          startDate: e.target.value,
                        },
                      }))
                    }
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label>Часы смены</Label>
                {(config.shift?.slots || []).map((slot, idx) => (
                  <div key={idx} className="flex items-center gap-2">
                    <TimeInput24
                      value={slot.start}
                      onChange={(val) => {
                        const slots = [...(config.shift?.slots || [])];
                        slots[idx] = { ...slots[idx], start: val };
                        setConfig((p) => ({
                          ...p,
                          shift: { ...(p.shift || defaultShift), slots },
                        }));
                      }}
                    />
                    <span className="text-muted-foreground">–</span>
                    <TimeInput24
                      value={slot.end}
                      onChange={(val) => {
                        const slots = [...(config.shift?.slots || [])];
                        slots[idx] = { ...slots[idx], end: val };
                        setConfig((p) => ({
                          ...p,
                          shift: { ...(p.shift || defaultShift), slots },
                        }));
                      }}
                    />
                  </div>
                ))}
              </div>
            </TabsContent>

            <TabsContent value="manual" className="pt-2">
              <div className="p-4 rounded-md border border-border text-sm text-muted-foreground">
                Все дни по умолчанию считаются свободными. Нажимайте на ячейки в календаре, чтобы указать рабочие часы на конкретные даты.
              </div>
            </TabsContent>
          </Tabs>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Отмена
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? "Сохранение..." : "Сохранить"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
