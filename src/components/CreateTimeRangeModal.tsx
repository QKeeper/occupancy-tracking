import React, { useState, useEffect } from "react";
import { User, TimeSlot, TimelineGroup } from "@/types";
import {
  DEFAULT_SCHEDULE_TIMEZONE,
  formatTimeZoneShort,
  getUserTimelineGroups,
  minutesToTime,
  normalizeTimeZone,
  timeToMinutes,
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
import { Clock, AlertCircle, Circle } from "lucide-react";
import { TintedPatternIcon } from "@/lib/timeline-pattern";
import { toast } from "sonner";

export interface CreateTimeRangeModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: User | null;
  date: Date | null;
  initialStart: string;
  initialEnd: string;
  onSave: (dateStr: string, slot: TimeSlot, groupId: string, note?: string) => Promise<void>;
}

function isImageSymbol(sym?: string): boolean {
  if (!sym) return false;
  return (
    sym.startsWith("data:image/") ||
    sym.startsWith("/uploads/") ||
    sym.startsWith("uploads/") ||
    sym.startsWith("http://") ||
    sym.startsWith("https://") ||
    /\.(png|svg|jpg|jpeg|webp|gif)(\?.*)?$/i.test(sym)
  );
}

function getImageSrc(sym: string): string {
  if (sym.startsWith("uploads/")) return `/${sym}`;
  if (!sym.startsWith("/") && !sym.startsWith("http") && !sym.startsWith("data:")) {
    return `/uploads/${sym}`;
  }
  return sym;
}

export const CreateTimeRangeModal: React.FC<CreateTimeRangeModalProps> = ({
  open,
  onOpenChange,
  user,
  date,
  initialStart,
  initialEnd,
  onSave,
}) => {
  const [startTime, setStartTime] = useState<string>("09:00");
  const [endTime, setEndTime] = useState<string>("10:00");
  const [selectedGroupId, setSelectedGroupId] = useState<string>("events");
  const [note, setNote] = useState<string>("");
  const [saving, setSaving] = useState<boolean>(false);

  useEffect(() => {
    if (open) {
      setStartTime(initialStart || "09:00");
      setEndTime(initialEnd || "10:00");
      setSelectedGroupId("events");
      setNote("");
    }
  }, [open, initialStart, initialEnd]);

  if (!user || !date) return null;

  const groups: TimelineGroup[] = getUserTimelineGroups(user);
  const viewerTz = normalizeTimeZone(user.time_zone || DEFAULT_SCHEDULE_TIMEZONE);
  const dateStr = format(date, "yyyy-MM-dd");
  const formattedDate = format(date, "EEEE, d MMMM", { locale: ru });

  // Calculate duration in minutes
  const startM = timeToMinutes(startTime);
  const endM = endTime === "24:00" ? 1440 : timeToMinutes(endTime);
  const durationMin = endM >= startM ? endM - startM : 1440 - startM + endM;
  const isOvernight = endM < startM;
  const isTooShort = durationMin < 30;

  const durationHours = Math.floor(durationMin / 60);
  const eventsGroup = groups.find((g) => g.id === "events" || g.id === "single");
  const eventsBgColor = eventsGroup?.style?.bgColor || "#6366f1";
  const eventsPatternColor = eventsGroup?.style?.patternColor || "#a5b4fc";
  const eventsSymbol = eventsGroup?.style?.symbol || "✨";

  const durationRemainingMins = durationMin % 60;
  let durationLabel = "";
  if (durationHours > 0) {
    durationLabel += `${durationHours} ч `;
  }
  if (durationRemainingMins > 0 || durationHours === 0) {
    durationLabel += `${durationRemainingMins} мин`;
  }

  const handleSave = async () => {
    if (isTooShort) {
      toast.error("Минимальная длительность интервала — 30 минут");
      return;
    }

    setSaving(true);
    try {
      await onSave(
        dateStr,
        { start: startTime, end: endTime },
        selectedGroupId,
        note.trim() || undefined
      );
      onOpenChange(false);
    } catch (e: any) {
      toast.error(e.message || "Не удалось сохранить интервал");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Clock className="size-5 text-primary" />
            <span>Новый временной промежуток</span>
          </DialogTitle>
          <DialogDescription className="capitalize">
            {formattedDate} • {formatTimeZoneShort(viewerTz)}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Настройка времени */}
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Время интервала</Label>

            <div className="flex items-center gap-2">
              <TimeInput24 value={startTime} onChange={setStartTime} />
              <span className="text-muted-foreground font-mono font-medium">–</span>
              <TimeInput24 value={endTime} onChange={setEndTime} allow24={true} />
              {isOvernight && (
                <span className="text-[10px] text-muted-foreground/80 font-normal px-1.5 py-0.5 rounded bg-muted/60">
                  +1 день
                </span>
              )}
            </div>

            <div className="text-xs font-mono text-muted-foreground pt-0.5">
              {durationLabel.trim()}
            </div>

            {isTooShort && (
              <div className="flex items-center gap-1.5 text-xs text-destructive pt-0.5">
                <AlertCircle className="size-3.5 shrink-0" />
                <span>Минимальная длительность — 30 минут</span>
              </div>
            )}
          </div>

          {/* Присвоение группе или без группы */}
          <div className="space-y-2">
            <Label className="text-xs font-medium">Категория:</Label>
            <div className="flex flex-col gap-1.5">
              {/* Опция: Без категории */}
              <button
                type="button"
                onClick={() => setSelectedGroupId("events")}
                className={`w-full p-2.5 rounded-lg border text-left flex items-center justify-between transition-all cursor-pointer ${
                  selectedGroupId === "events"
                    ? "border-primary bg-primary/10 text-foreground ring-1 ring-primary/40 shadow-xs"
                    : "border-border bg-card/60 text-muted-foreground hover:text-foreground hover:bg-muted/30"
                }`}
              >
                <div className="flex items-center gap-2.5">
                  <div
                    className="size-6 rounded-md flex items-center justify-center shrink-0 shadow-xs overflow-hidden"
                    style={{ backgroundColor: eventsBgColor }}
                  >
                    <TintedPatternIcon
                      symbol={getImageSrc(eventsSymbol)}
                      color={eventsPatternColor}
                      size={14}
                    />
                  </div>
                  <div className="text-xs font-semibold text-foreground">
                    Без категории
                  </div>
                </div>
                <div
                  className={`size-4 rounded-full border flex items-center justify-center shrink-0 transition-colors ${
                    selectedGroupId === "events"
                      ? "border-primary"
                      : "border-muted-foreground/40"
                  }`}
                >
                  {selectedGroupId === "events" && (
                    <Circle className="size-2 fill-primary text-primary shrink-0" />
                  )}
                </div>
              </button>

              {/* Существующие группы пользователя */}
              {groups.filter((g) => g.id !== "events" && g.id !== "single").map((g) => {
                const isSelected = selectedGroupId === g.id;
                const sym = g.style.symbol || "⚡";
                return (
                  <button
                    key={g.id}
                    type="button"
                    onClick={() => setSelectedGroupId(g.id)}
                    className={`w-full p-2.5 rounded-lg border text-left flex items-center justify-between transition-all cursor-pointer ${
                      isSelected
                        ? "border-primary bg-primary/10 text-foreground ring-1 ring-primary/40 shadow-xs"
                        : "border-border bg-card/60 text-muted-foreground hover:text-foreground hover:bg-muted/30"
                    }`}
                  >
                    <div className="flex items-center gap-2.5">
                      <div
                        className="size-6 rounded-md flex items-center justify-center shrink-0 shadow-xs overflow-hidden"
                        style={{ backgroundColor: g.style.bgColor }}
                      >
                        <TintedPatternIcon
                          symbol={getImageSrc(sym)}
                          color={g.style.patternColor}
                          size={14}
                        />
                      </div>
                      <div className="text-xs font-semibold text-foreground">{g.name}</div>
                    </div>
                    <div
                      className={`size-4 rounded-full border flex items-center justify-center shrink-0 transition-colors ${
                        isSelected
                          ? "border-primary"
                          : "border-muted-foreground/40"
                      }`}
                    >
                      {isSelected && (
                        <Circle className="size-2 fill-primary text-primary shrink-0" />
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Заметка / Название */}
          <div className="space-y-1.5">
            <Label htmlFor="create-note" className="text-xs font-medium">
              Заметка / Название события
            </Label>
            <Input
              id="create-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Например: Встреча, Врач, Тренировка..."
            />
          </div>
        </div>

        <DialogFooter className="flex sm:justify-between items-center w-full gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Отмена
          </Button>
          <Button onClick={handleSave} disabled={saving || isTooShort}>
            {saving ? "Сохранение..." : "Создать интервал"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
