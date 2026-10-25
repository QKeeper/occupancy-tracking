import * as React from "react";
import { cn } from "@/lib/utils";

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
        "inline-flex items-center h-8 rounded-lg border border-input bg-transparent dark:bg-input/30 px-2 font-mono text-xs transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50",
        className
      )}
    >
      <select
        value={hh}
        onChange={(e) => onChange(`${e.target.value}:${rawMm}`)}
        className="bg-transparent text-foreground outline-none cursor-pointer pr-0.5 appearance-none text-center"
        aria-label="Часы"
      >
        {HOURS.map((h) => (
          <option key={h} value={h} className="bg-popover text-popover-foreground">
            {h}
          </option>
        ))}
      </select>
      <span className="text-muted-foreground mx-0.5 select-none">:</span>
      <select
        value={rawMm}
        onChange={(e) => onChange(`${hh}:${e.target.value}`)}
        className="bg-transparent text-foreground outline-none cursor-pointer pl-0.5 appearance-none text-center"
        aria-label="Минуты"
      >
        {minuteOptions.map((m) => (
          <option key={m} value={m} className="bg-popover text-popover-foreground">
            {m}
          </option>
        ))}
      </select>
    </div>
  );
};
