import React, { useState, useEffect } from "react";
import { User, DayOverride, TimeSlot, TimelineGroup } from "@/types";
import {
  DEFAULT_SCHEDULE_TIMEZONE,
  formatTimeZoneShort,
  getRawGroupDaySchedule,
  getUserTimelineGroups,
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TimeInput24 } from "@/components/ui/time-input-24";
import { format } from "date-fns";
import { ru } from "date-fns/locale/ru";
import { Plus, Trash2, RotateCcw } from "lucide-react";
import { toast } from "sonner";

interface DayOverrideModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: User | null;
  date: Date | null;
  initialGroupId?: string;
  onSaveOverride: (
    userId: number,
    dateStr: string,
    override: DayOverride | null,
    expectedOverride?: DayOverride | null,
    groupId?: string
  ) => Promise<void>;
}

export const DayOverrideModal: React.FC<DayOverrideModalProps> = ({
  open,
  onOpenChange,
  user,
  date,
  initialGroupId,
  onSaveOverride,
}) => {
  const groups: TimelineGroup[] = user ? getUserTimelineGroups(user) : [];
  const [selectedGroupId, setSelectedGroupId] = useState<string>(initialGroupId || "work");
  const [status, setStatus] = useState<"free" | "working" | "partial">("free");
  const [slots, setSlots] = useState<TimeSlot[]>([]);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [expectedOverride, setExpectedOverride] = useState<DayOverride | null>(null);

  // Sync selected group and form state when opening or switching group
  useEffect(() => {
    if (!open || !user || !date) return;
    const targetId = initialGroupId && groups.some((g) => g.id === initialGroupId)
      ? initialGroupId
      : groups[0]?.id || "work";
    setSelectedGroupId(targetId);
  }, [open, user?.id, initialGroupId]);

  useEffect(() => {
    if (!open || !user || !date) return;
    const currentGroup = groups.find((g) => g.id === selectedGroupId) || groups[0];
    if (!currentGroup) return;

    const dateStr = format(date, "yyyy-MM-dd");
    const groupOverride = currentGroup.overrides?.[dateStr] ?? null;
    setExpectedOverride(groupOverride);

    if (groupOverride) {
      setStatus(groupOverride.status);
      setSlots(groupOverride.slots.length > 0 ? groupOverride.slots.map((s) => ({ ...s })) : []);
      setNote(groupOverride.note || "");
    } else {
      const viewerTz = normalizeTimeZone(user.time_zone || DEFAULT_SCHEDULE_TIMEZONE);
      const computed = getRawGroupDaySchedule(currentGroup, date, viewerTz);
      setStatus(computed.status);
      setSlots(
        computed.slots.length > 0
          ? computed.slots.map((s) => ({ ...s }))
          : currentGroup.id === "sleep"
          ? [{ start: "23:00", end: "07:00" }]
          : [{ start: "10:00", end: "18:00" }]
      );
      setNote(computed.note || "");
    }
  }, [open, selectedGroupId, date?.getTime(), user?.id, user?.revision]);

  if (!user || !date) return null;

  const currentGroup = groups.find((g) => g.id === selectedGroupId) || groups[0];
  const viewerTz = normalizeTimeZone(user.time_zone || DEFAULT_SCHEDULE_TIMEZONE);
  const dateStr = format(date, "yyyy-MM-dd");
  const formattedDate = format(date, "EEEE, d MMMM", { locale: ru });
  const hasExistingOverride = Boolean(currentGroup?.overrides?.[dateStr]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const finalSlots = status === "free" ? [] : slots;
      await onSaveOverride(
        user.id,
        dateStr,
        {
          status,
          slots: finalSlots,
          note: note.trim() || undefined,
          ...(viewerTz !== DEFAULT_SCHEDULE_TIMEZONE ? { timeZone: viewerTz } : {}),
        },
        expectedOverride,
        selectedGroupId
      );
      toast.success("Сохранено");
      onOpenChange(false);
    } catch (e: any) {
      toast.error(e.message || "Не удалось сохранить");
    } finally {
      setSaving(false);
    }
  };

  const handleResetToDefault = async () => {
    setSaving(true);
    try {
      await onSaveOverride(user.id, dateStr, null, expectedOverride, selectedGroupId);
      toast.info("Сброшено к базовому расписанию группы");
      onOpenChange(false);
    } catch (e: any) {
      toast.error(e.message || "Ошибка сброса");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{user.display_name.replace(" (Вы)", "")}</DialogTitle>
          <DialogDescription className="capitalize">
            {formattedDate} • {formatTimeZoneShort(viewerTz)}
          </DialogDescription>
        </DialogHeader>

        {/* Переключатель группы таймлайнов */}
        {groups.length > 1 && (
          <div className="space-y-1.5 pt-1">
            <Label className="text-xs text-muted-foreground">Группа таймлайна:</Label>
            <div className="flex flex-wrap gap-1.5">
              {groups.map((g) => {
                const isActive = g.id === selectedGroupId;
                return (
                  <button
                    key={g.id}
                    type="button"
                    onClick={() => setSelectedGroupId(g.id)}
                    className={`px-2.5 py-1 rounded-lg text-xs font-medium flex items-center gap-1.5 border transition-all cursor-pointer ${
                      isActive
                        ? "border-primary bg-primary/10 text-foreground ring-1 ring-primary/40 shadow-xs"
                        : "border-border bg-card/60 text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <span
                      className="size-2 rounded-full shrink-0"
                      style={{ backgroundColor: g.style.bgColor }}
                    />
                    <span>{g.name}</span>
                    {g.overrides?.[dateStr] && (
                      <span className="size-1.5 rounded-full bg-primary" title="Есть ручная правка" />
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="space-y-4 py-2">
          <div className="grid grid-cols-3 gap-2">
            <Button
              type="button"
              variant={status === "free" ? "default" : "outline"}
              size="sm"
              onClick={() => setStatus("free")}
            >
              Свободен
            </Button>
            <Button
              type="button"
              variant={status === "partial" ? "default" : "outline"}
              size="sm"
              onClick={() => {
                setStatus("partial");
                if (slots.length === 0) setSlots([{ start: "10:00", end: "14:00" }]);
              }}
            >
              Частично
            </Button>
            <Button
              type="button"
              variant={status === "working" ? "default" : "outline"}
              size="sm"
              onClick={() => {
                setStatus("working");
                if (slots.length === 0) {
                  setSlots(
                    selectedGroupId === "sleep"
                      ? [{ start: "23:00", end: "07:00" }]
                      : [{ start: "09:00", end: "18:00" }]
                  );
                }
              }}
            >
              Занят
            </Button>
          </div>

          {status !== "free" && (
            <div className="space-y-2 p-3 rounded-md border border-border">
              <Label className="text-xs">
                Интервалы времени ({currentGroup?.name || "Группа"})
              </Label>
              {slots.map((slot, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <TimeInput24
                    value={slot.start}
                    onChange={(val) => {
                      const next = [...slots];
                      next[idx] = { ...next[idx], start: val };
                      setSlots(next);
                    }}
                  />
                  <span className="text-muted-foreground">–</span>
                  <TimeInput24
                    value={slot.end}
                    onChange={(val) => {
                      const next = [...slots];
                      next[idx] = { ...next[idx], end: val };
                      setSlots(next);
                    }}
                  />
                  {slots.length > 1 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => setSlots(slots.filter((_, i) => i !== idx))}
                      className="size-8 text-muted-foreground hover:text-destructive shrink-0"
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  )}
                </div>
              ))}

              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() =>
                  setSlots([
                    ...slots,
                    selectedGroupId === "sleep"
                      ? { start: "14:00", end: "16:00" }
                      : { start: "18:00", end: "21:00" },
                  ])
                }
                className="text-xs h-7 px-2"
              >
                <Plus className="size-3.5 mr-1" />
                Добавить интервал
              </Button>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="day-note">Заметка</Label>
            <Input
              id="day-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Комментарий к этому дню..."
            />
          </div>
        </div>

        <DialogFooter className="flex sm:justify-between items-center w-full">
          {hasExistingOverride ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleResetToDefault}
              disabled={saving}
              className="text-muted-foreground"
            >
              <RotateCcw className="size-3.5 mr-1" />
              Сбросить для «{currentGroup?.name}»
            </Button>
          ) : (
            <div />
          )}
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Отмена
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              Сохранить
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
