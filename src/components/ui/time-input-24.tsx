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

  // Synchronous key typing buffers to eliminate async state race conditions
  const hourBufferRef = React.useRef<string>("");
  const minuteBufferRef = React.useRef<string>("");

  // Parse "HH:MM" safely
  const parts = (value || "09:00").split(":");
  const hNum = Math.max(0, Math.min(23, parseInt(parts[0] || "9", 10) || 0));
  const mNum = Math.max(0, Math.min(59, parseInt(parts[1] || "0", 10) || 0));
  const hh = String(hNum).padStart(2, "0");
  const mm = String(mNum).padStart(2, "0");

  const [hourVal, setHourVal] = React.useState(hh);
  const [minuteVal, setMinuteVal] = React.useState(mm);

  // Latest committed values ref for atomic access inside event handlers
  const latestHourRef = React.useRef(hh);
  const latestMinuteRef = React.useRef(mm);

  React.useEffect(() => {
    setHourVal(hh);
    setMinuteVal(mm);
    latestHourRef.current = hh;
    latestMinuteRef.current = mm;
  }, [hh, mm]);

  const commitTime = React.useCallback(
    (nextH: string, nextM: string) => {
      const validH = String(Math.max(0, Math.min(23, parseInt(nextH, 10) || 0))).padStart(2, "0");
      const validM = String(Math.max(0, Math.min(59, parseInt(nextM, 10) || 0))).padStart(2, "0");
      latestHourRef.current = validH;
      latestMinuteRef.current = validM;
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
      hourBufferRef.current = "";
      minuteRef.current?.focus();
      minuteRef.current?.select();
      return;
    }

    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      hourBufferRef.current = "";
      const delta = e.key === "ArrowUp" ? 1 : -1;
      const currentH = parseInt(latestHourRef.current, 10) || 0;
      const nextH = String((currentH + delta + 24) % 24).padStart(2, "0");
      commitTime(nextH, latestMinuteRef.current);
      return;
    }

    if (e.key === "Backspace") {
      e.preventDefault();
      hourBufferRef.current = "";
      commitTime("00", latestMinuteRef.current);
      return;
    }

    if (e.key >= "0" && e.key <= "9") {
      e.preventDefault();
      const digit = e.key;
      const buffer = hourBufferRef.current;

      if (!buffer) {
        // First digit typed
        const num = parseInt(digit, 10);
        if (num > 2) {
          // Numbers 3-9 cannot start a 2-digit 24h hour (max 23).
          // Immediately commit "03".."09" and jump focus to minutes.
          const nextH = `0${digit}`;
          hourBufferRef.current = "";
          commitTime(nextH, latestMinuteRef.current);
          minuteRef.current?.focus();
          minuteRef.current?.select();
        } else {
          // Numbers 0, 1, 2: store first digit in buffer, preview "0X" and wait for second digit.
          hourBufferRef.current = digit;
          setHourVal(`0${digit}`);
          commitTime(`0${digit}`, latestMinuteRef.current);
        }
      } else {
        // Second digit typed! Combine buffer + second digit (e.g. '1' + '8' = '18').
        const firstDigit = buffer;
        const combined = parseInt(firstDigit + digit, 10);
        hourBufferRef.current = "";

        if (combined <= 23) {
          const nextH = String(combined).padStart(2, "0");
          commitTime(nextH, latestMinuteRef.current);
        } else {
          // If out of range (e.g. buffer was '2' and user typed '5' -> 25 > 23), set '05'.
          commitTime(`0${digit}`, latestMinuteRef.current);
        }

        // Advance to minutes input
        minuteRef.current?.focus();
        minuteRef.current?.select();
      }
    }
  };

  const handleMinuteKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Tab") return;

    if (e.key === "ArrowLeft") {
      e.preventDefault();
      minuteBufferRef.current = "";
      hourRef.current?.focus();
      hourRef.current?.select();
      return;
    }

    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      minuteBufferRef.current = "";
      const delta = e.key === "ArrowUp" ? 5 : -5;
      const currentM = parseInt(latestMinuteRef.current, 10) || 0;
      const nextM = String((Math.round(currentM / 5) * 5 + delta + 60) % 60).padStart(2, "0");
      commitTime(latestHourRef.current, nextM);
      return;
    }

    if (e.key === "Backspace") {
      e.preventDefault();
      minuteBufferRef.current = "";
      commitTime(latestHourRef.current, "00");
      return;
    }

    if (e.key >= "0" && e.key <= "9") {
      e.preventDefault();
      const digit = e.key;
      const buffer = minuteBufferRef.current;

      if (!buffer) {
        // First digit typed
        const num = parseInt(digit, 10);
        if (num > 5) {
          // Numbers 6-9 cannot start a 2-digit minute (max 59).
          const nextM = `0${digit}`;
          minuteBufferRef.current = "";
          commitTime(latestHourRef.current, nextM);
        } else {
          // Numbers 0-5: store first digit in buffer, preview "0X", wait for second digit.
          minuteBufferRef.current = digit;
          setMinuteVal(`0${digit}`);
          commitTime(latestHourRef.current, `0${digit}`);
        }
      } else {
        // Second digit typed!
        const firstDigit = buffer;
        const combined = parseInt(firstDigit + digit, 10);
        minuteBufferRef.current = "";

        if (combined <= 59) {
          const nextM = String(combined).padStart(2, "0");
          commitTime(latestHourRef.current, nextM);
        } else {
          commitTime(latestHourRef.current, `0${digit}`);
        }
      }
    }
  };

  const handleWheel = (type: "hour" | "minute", e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY < 0 ? 1 : -1;
    if (type === "hour") {
      hourBufferRef.current = "";
      const currentH = parseInt(latestHourRef.current, 10) || 0;
      const nextH = String((currentH + delta + 24) % 24).padStart(2, "0");
      commitTime(nextH, latestMinuteRef.current);
    } else {
      minuteBufferRef.current = "";
      const currentM = parseInt(latestMinuteRef.current, 10) || 0;
      const nextM = String((Math.round(currentM / 5) * 5 + delta * 5 + 60) % 60).padStart(2, "0");
      commitTime(latestHourRef.current, nextM);
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
          hourBufferRef.current = "";
          hourRef.current?.select();
        }}
        onBlur={() => {
          hourBufferRef.current = "";
          commitTime(latestHourRef.current, latestMinuteRef.current);
        }}
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
          minuteBufferRef.current = "";
          minuteRef.current?.select();
        }}
        onBlur={() => {
          minuteBufferRef.current = "";
          commitTime(latestHourRef.current, latestMinuteRef.current);
        }}
        onChange={() => {}}
        onKeyDown={handleMinuteKeyDown}
        onWheel={(e) => handleWheel("minute", e)}
        className="w-6 h-6 text-center font-mono text-xs bg-transparent border-0 outline-none p-0 text-foreground focus:bg-accent/60 rounded select-all cursor-text tabular-nums"
      />
    </div>
  );
};
