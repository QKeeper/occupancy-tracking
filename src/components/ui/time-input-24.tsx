import * as React from "react";
import { cn } from "@/lib/utils";
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from "@/components/ui/select";

interface TimeInput24Props {
  value: string; // "HH:MM"
  onChange: (value: string) => void;
  className?: string;
}

const HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0"));
const MINUTES = ["00", "05", "10", "15", "20", "25", "30", "35", "40", "45", "50", "55"];

export const TimeInput24: React.FC<TimeInput24Props> = ({ value, onChange, className }) => {
  const parts = (value || "09:00").split(":");
  const hh = String(Math.max(0, Math.min(23, parseInt(parts[0] || "9", 10) || 0))).padStart(
    2,
    "0"
  );
  const rawMm = String(Math.max(0, Math.min(59, parseInt(parts[1] || "0", 10) || 0))).padStart(
    2,
    "0"
  );

  const minuteOptions = MINUTES.includes(rawMm)
    ? MINUTES
    : [...MINUTES, rawMm].sort();

  return (
    <div
      className={cn(
        "inline-flex items-center h-8 rounded-lg border border-input bg-transparent dark:bg-input/30 px-1 font-mono text-xs transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50",
        className
      )}
    >
      <Select
        value={hh}
        onValueChange={(val) => onChange(`${val}:${rawMm}`)}
      >
        <SelectTrigger
          variant="ghost"
          size="xs"
          hideChevron
          aria-label="Часы"
          className="w-7 h-6 px-0 text-center font-mono text-xs justify-center hover:bg-muted/50 rounded"
        >
          <SelectValue>{hh}</SelectValue>
        </SelectTrigger>
        <SelectContent className="min-w-[4.5rem] max-h-[224px]">
          {HOURS.map((h) => (
            <SelectItem key={h} value={h} className="font-mono text-xs">
              {h}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <span className="text-muted-foreground mx-0.5 select-none font-semibold">:</span>

      <Select
        value={rawMm}
        onValueChange={(val) => onChange(`${hh}:${val}`)}
      >
        <SelectTrigger
          variant="ghost"
          size="xs"
          hideChevron
          aria-label="Минуты"
          className="w-7 h-6 px-0 text-center font-mono text-xs justify-center hover:bg-muted/50 rounded"
        >
          <SelectValue>{rawMm}</SelectValue>
        </SelectTrigger>
        <SelectContent className="min-w-[4.5rem] max-h-[224px]">
          {minuteOptions.map((m) => (
            <SelectItem key={m} value={m} className="font-mono text-xs">
              {m}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
};
