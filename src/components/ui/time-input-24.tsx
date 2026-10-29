import * as React from "react";
import { cn } from "@/lib/utils";

export interface TimeInput24Props {
  value: string; // "HH:MM"
  onChange: (value: string) => void;
  className?: string;
  disabled?: boolean;
}

export const TimeInput24: React.FC<TimeInput24Props> = ({
  value,
  onChange,
  className,
  disabled = false,
}) => {
  const hourRef = React.useRef<HTMLInputElement>(null);
  const minuteRef = React.useRef<HTMLInputElement>(null);
  const [hourFlag, setHourFlag] = React.useState<boolean>(false);
  const [minuteFlag, setMinuteFlag] = React.useState<boolean>(false);

  // Parse "HH:MM" value safely
  const parts = (value || "09:00").split(":");
  const hNum = Math.max(0, Math.min(23, parseInt(parts[0] || "9", 10) || 0));
  const mNum = Math.max(0, Math.min(59, parseInt(parts[1] || "0", 10) || 0));
  const hh = String(hNum).padStart(2, "0");
  const mm = String(mNum).padStart(2, "0");

  const [hourVal, setHourVal] = React.useState(hh);
  const [minuteVal, setMinuteVal] = React.useState(mm);

  React.useEffect(() => {
    setHourVal(hh);
    setMinuteVal(mm);
  }, [hh, mm]);

  const commitTime = React.useCallback(
    (nextH: string, nextM: string) => {
      const validH = String(Math.max(0, Math.min(23, parseInt(nextH, 10) || 0))).padStart(2, "0");
      const validM = String(Math.max(0, Math.min(59, parseInt(nextM, 10) || 0))).padStart(2, "0");
      setHourVal(validH);
      setMinuteVal(validM);
      onChange(`${validH}:${validM}`);
    },
    [onChange]
  );

  const handleHourKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Tab") return;

    if (e.key === "ArrowRight") {
      e.preventDefault();
      minuteRef.current?.focus();
      minuteRef.current?.select();
      return;
    }

    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const delta = e.key === "ArrowUp" ? 1 : -1;
      const currentH = parseInt(hourVal, 10) || 0;
      const nextH = String((currentH + delta + 24) % 24).padStart(2, "0");
      commitTime(nextH, minuteVal);
      setHourFlag(false);
      return;
    }

    if (e.key === "Backspace") {
      e.preventDefault();
      setHourVal("00");
      commitTime("00", minuteVal);
      setHourFlag(false);
      return;
    }

    if (e.key >= "0" && e.key <= "9") {
      e.preventDefault();
      const num = parseInt(e.key, 10);
      if (!hourFlag) {
        // First character typed
        if (num > 2) {
          // Numbers 3-9 cannot start a 2-digit 24h hour, so treat as "0X" and jump to minutes
          const nextH = `0${num}`;
          commitTime(nextH, minuteVal);
          setHourFlag(false);
          minuteRef.current?.focus();
          minuteRef.current?.select();
        } else {
          setHourVal(`0${num}`);
          commitTime(`0${num}`, minuteVal);
          setHourFlag(true);
        }
      } else {
        // Second character typed
        const combined = parseInt(hourVal[1] + e.key, 10);
        const nextH = combined <= 23 ? String(combined).padStart(2, "0") : `0${num}`;
        commitTime(nextH, minuteVal);
        setHourFlag(false);
        minuteRef.current?.focus();
        minuteRef.current?.select();
      }
    }
  };

  const handleMinuteKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Tab") return;

    if (e.key === "ArrowLeft") {
      e.preventDefault();
      hourRef.current?.focus();
      hourRef.current?.select();
      return;
    }

    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const delta = e.key === "ArrowUp" ? 5 : -5;
      const currentM = parseInt(minuteVal, 10) || 0;
      const nextM = String((Math.round(currentM / 5) * 5 + delta + 60) % 60).padStart(2, "0");
      commitTime(hourVal, nextM);
      setMinuteFlag(false);
      return;
    }

    if (e.key === "Backspace") {
      e.preventDefault();
      setMinuteVal("00");
      commitTime(hourVal, "00");
      setMinuteFlag(false);
      return;
    }

    if (e.key >= "0" && e.key <= "9") {
      e.preventDefault();
      const num = parseInt(e.key, 10);
      if (!minuteFlag) {
        if (num > 5) {
          const nextM = `0${num}`;
          commitTime(hourVal, nextM);
          setMinuteFlag(false);
        } else {
          setMinuteVal(`0${num}`);
          commitTime(hourVal, `0${num}`);
          setMinuteFlag(true);
        }
      } else {
        const combined = parseInt(minuteVal[1] + e.key, 10);
        const nextM = combined <= 59 ? String(combined).padStart(2, "0") : `0${num}`;
        commitTime(hourVal, nextM);
        setMinuteFlag(false);
      }
    }
  };

  const handleWheel = (type: "hour" | "minute", e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY < 0 ? 1 : -1;
    if (type === "hour") {
      const currentH = parseInt(hourVal, 10) || 0;
      const nextH = String((currentH + delta + 24) % 24).padStart(2, "0");
      commitTime(nextH, minuteVal);
    } else {
      const currentM = parseInt(minuteVal, 10) || 0;
      const nextM = String((Math.round(currentM / 5) * 5 + delta * 5 + 60) % 60).padStart(2, "0");
      commitTime(hourVal, nextM);
    }
  };

  return (
    <div
      data-slot="time-picker-24"
      className={cn(
        "inline-flex items-center h-8 rounded-lg border border-input bg-transparent dark:bg-input/30 px-1 font-mono text-xs transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 select-none",
        disabled && "opacity-50 pointer-events-none",
        className
      )}
    >
      <input
        ref={hourRef}
        type="text"
        inputMode="numeric"
        aria-label="Часы (24ч)"
        value={hourVal}
        disabled={disabled}
        onFocus={() => {
          hourRef.current?.select();
          setHourFlag(false);
        }}
        onBlur={() => commitTime(hourVal, minuteVal)}
        onChange={() => {}}
        onKeyDown={handleHourKeyDown}
        onWheel={(e) => handleWheel("hour", e)}
        className="w-6 h-6 text-center font-mono text-xs bg-transparent border-0 outline-none p-0 text-foreground focus:bg-accent/60 rounded select-all cursor-text tabular-nums"
      />
      <span className="text-muted-foreground select-none font-bold text-xs -mx-0.5">:</span>
      <input
        ref={minuteRef}
        type="text"
        inputMode="numeric"
        aria-label="Минуты"
        value={minuteVal}
        disabled={disabled}
        onFocus={() => {
          minuteRef.current?.select();
          setMinuteFlag(false);
        }}
        onBlur={() => commitTime(hourVal, minuteVal)}
        onChange={() => {}}
        onKeyDown={handleMinuteKeyDown}
        onWheel={(e) => handleWheel("minute", e)}
        className="w-6 h-6 text-center font-mono text-xs bg-transparent border-0 outline-none p-0 text-foreground focus:bg-accent/60 rounded select-all cursor-text tabular-nums"
      />
    </div>
  );
};
