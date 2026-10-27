import React, { useState, useEffect } from "react";
import { User, DayOverride, TimeSlot } from "@/types";
import {
  DEFAULT_SCHEDULE_TIMEZONE,
  formatTimeZoneShort,
  getUserDaySchedule,
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
  onSaveOverride: (userId: number, dateStr: string, override: DayOverride | null, expectedOverride?: DayOverride | null) => Promise<void>;
}

export const DayOverrideModal: React.FC<DayOverrideModalProps> = ({
  open,
  onOpenChange,
  user,
  date,
  onSaveOverride,
}) => {
  const [status, setStatus] = useState<"free" | "working" | "partial">("free");
  const [slots, setSlots] = useState<TimeSlot[]>([]);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [expectedOverride, setExpectedOverride] = useState<DayOverride | null>(null);

  useEffect(() => {
    if (open && user && date) {
      const viewerTz = normalizeTimeZone(user.time_zone || DEFAULT_SCHEDULE_TIMEZONE);
      const computed = getUserDaySchedule(user, date, viewerTz);
      setExpectedOverride(user.overrides?.[format(date, "yyyy-MM-dd")] ?? null);
      setStatus(computed.status);
      setSlots(
        computed.slots.length > 0
          ? computed.slots.map((s) => ({ ...s }))
          : [{ start: "10:00", end: "18:00" }]
      );
      setNote(computed.note || "");
    }
  }, [open, user?.id, user?.time_zone, date?.getTime()]);

  if (!user || !date) return null;

  const viewerTz = normalizeTimeZone(user.time_zone || DEFAULT_SCHEDULE_TIMEZONE);
  const dateStr = format(date, "yyyy-MM-dd");
  const formattedDate = format(date, "EEEE, d MMMM", { locale: ru });
  const hasExistingOverride = Boolean(user.overrides?.[dateStr]);

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
        expectedOverride
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
      await onSaveOverride(user.id, dateStr, null, expectedOverride);
      toast.info("Сброшено к базовому графику");
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
                if (slots.length === 0) setSlots([{ start: "09:00", end: "18:00" }]);
              }}
            >
              Занят
            </Button>
          </div>

          {status !== "free" && (
            <div className="space-y-2 p-3 rounded-md border border-border">
              <Label className="text-xs">Рабочие часы</Label>
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
                onClick={() => setSlots([...slots, { start: "18:00", end: "21:00" }])}
                className="text-xs h-7 px-2"
              >
                <Plus className="size-3.5 mr-1" />
                Добавить слот
              </Button>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="day-note">Заметка</Label>
            <Input
              id="day-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Комментарий..."
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
              Сбросить
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
