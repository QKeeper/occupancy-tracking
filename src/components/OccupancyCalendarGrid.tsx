import React, {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
} from "react";
import { User } from "@/types";
import {
  DEFAULT_SCHEDULE_TIMEZONE,
  computeContinuousFreeOverlap,
  computeUserContinuousBusyBlocks,
  getNowInTimeZone,
  layoutBusyBlocks,
  normalizeTimeZone,
} from "@/lib/schedule-engine";
import { getTimelineBlockStyle } from "@/lib/timeline-pattern";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { format, isWeekend } from "date-fns";
import { ru } from "date-fns/locale/ru";
import { Check, ZoomIn, ZoomOut } from "lucide-react";

interface OccupancyCalendarGridProps {
  days: Date[];
  members: User[];
  currentUser: User;
  selectedMemberIds: number[];
  onToggleMemberFilter: (userId: number) => void;
  onSelectCombinationPreset: (ids: number[]) => void;
  onReorderMembers?: (newMemberIds: number[]) => void;
  onCellClick: (user: User, date: Date, groupId?: string) => void;
  onOpenMySchedule: () => void;
  scrollCommand?: {
    type: "today" | "preserve-day" | "week-nav";
    targetDayOffset?: number;
    seq: number;
  };
  onScrollDayOffsetChange?: (dayOffset: number) => void;
}

const HOURS_24 = Array.from({ length: 24 }, (_, i) => i);
const MIN_HOUR_WIDTH = 12;
const MAX_HOUR_WIDTH = 64;
const MEMBER_COLUMN_WIDTH = 198;
const MEMBER_ROW_HEIGHT = 55;
const STORAGE_HOUR_WIDTH_KEY = "syncro_timeline_hour_width";
const STORAGE_DAY_OFFSET_KEY = "syncro_timeline_day_offset";

export const OccupancyCalendarGrid: React.FC<OccupancyCalendarGridProps> = ({
  days,
  members,
  currentUser,
  selectedMemberIds,
  onToggleMemberFilter,
  onSelectCombinationPreset,
  onReorderMembers,
  onCellClick,
  onOpenMySchedule,
  scrollCommand,
  onScrollDayOffsetChange,
}) => {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const minimapRef = useRef<HTMLDivElement>(null);
  const minimapViewportRef = useRef<HTMLDivElement>(null);
  const persistPositionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingDayOffsetRef = useRef<number | null>(null);
  const [hourWidth, setHourWidth] = useState<number>(() => {
    const saved = localStorage.getItem(STORAGE_HOUR_WIDTH_KEY);
    const parsed = saved ? Number(saved) : NaN;
    if (!Number.isNaN(parsed) && parsed >= MIN_HOUR_WIDTH && parsed <= MAX_HOUR_WIDTH) {
      return parsed;
    }
    return 36;
  });
  const [isDraggingTimeline, setIsDraggingTimeline] = useState<boolean>(false);

  const currentDayOffsetRef = useRef<number>(0);
  const prevHourWidthRef = useRef<number>(hourWidth);
  // Optional cursor anchor when zooming via mouse wheel: { dayOffsetAtCursor, mouseX }
  const wheelZoomAnchorRef = useRef<{ dayOffsetAtCursor: number; mouseX: number } | null>(
    null
  );

  // Drag & inertia refs
  const isPointerDownRef = useRef<boolean>(false);
  const hasDraggedRef = useRef<boolean>(false);
  const dragStartXRef = useRef<number>(0);
  const dragStartScrollLeftRef = useRef<number>(0);
  const dragRafRef = useRef<number | null>(null);
  const lastPointerXRef = useRef<number>(0);
  const velocitySamplesRef = useRef<Array<{ x: number; t: number }>>([]);
  const inertiaRafRef = useRef<number | null>(null);

  // Viewport tracking for the VSCode-style minimap
  const isDraggingMinimapRef = useRef(false);

  // Vertical-only drag-and-drop state for reordering members
  const [memberDragState, setMemberDragState] = useState<{
    memberId: number;
    startIndex: number;
    targetIndex: number;
    offsetY: number;
  } | null>(null);
  const memberDragRef = useRef<{
    memberId: number;
    startIndex: number;
    targetIndex: number;
    startY: number;
    offsetY: number;
    hasMoved: boolean;
    memberIds: number[];
  } | null>(null);
  const suppressMemberClickRef = useRef(false);
  const onReorderMembersRef = useRef(onReorderMembers);
  onReorderMembersRef.current = onReorderMembers;

  const isFilterActive = selectedMemberIds.length > 0;
  const allMemberIds = members.map((m) => m.id);
  const allSelected =
    allMemberIds.length > 0 && selectedMemberIds.length === allMemberIds.length;

  const dayWidth = hourWidth * 24;
  const totalTimelineWidth = days.length * dayWidth;
  const totalMinutes = days.length * 1440;

  const stopInertia = useCallback(() => {
    if (inertiaRafRef.current !== null) {
      cancelAnimationFrame(inertiaRafRef.current);
      inertiaRafRef.current = null;
    }
  }, []);

  const viewerTimeZone = normalizeTimeZone(
    currentUser.time_zone || DEFAULT_SCHEDULE_TIMEZONE
  );

  const selectedUsers = useMemo(
    () =>
      members
        .filter((m) => selectedMemberIds.includes(m.id))
        .map((m) => (m.id === currentUser.id ? { ...m, ...currentUser } : m)),
    [members, selectedMemberIds, currentUser]
  );

  // Continuous common free windows across the entire multi-day timeline
  const continuousFreeWindows = useMemo(
    () => computeContinuousFreeOverlap(selectedUsers, days, 60, viewerTimeZone),
    [selectedUsers, days, viewerTimeZone]
  );

  // Precompute busy blocks for each member
  const busyBlocksByMember = useMemo(() => {
    const map: Record<number, ReturnType<typeof layoutBusyBlocks>> = {};
    for (const m of members) {
      const userToCompute = m.id === currentUser.id ? { ...m, ...currentUser } : m;
      map[m.id] = layoutBusyBlocks(
        computeUserContinuousBusyBlocks(userToCompute, days, viewerTimeZone)
      );
    }
    return map;
  }, [members, currentUser, days, viewerTimeZone]);

  // Generate each member's pattern once, rather than once per busy block/render.
  const blockStylesByMember = useMemo(() => {
    const styles: Record<number, React.CSSProperties> = {};
    for (const member of members) {
      styles[member.id] = getTimelineBlockStyle(
        member.id === currentUser.id ? currentUser.timeline_style : member.timeline_style
      );
    }
    return styles;
  }, [members, currentUser.id, currentUser.timeline_style]);

  const hourGridStyle = (opacity: number): React.CSSProperties => ({
    backgroundImage: `repeating-linear-gradient(to right, transparent 0px, transparent ${hourWidth - 1}px, color-mix(in oklab, var(--border) ${opacity}%, transparent) ${hourWidth - 1}px, color-mix(in oklab, var(--border) ${opacity}%, transparent) ${hourWidth}px)`,
  });

  const minToPx = (mins: number) => (mins / 60) * hourWidth;

  const nowInTz = getNowInTimeZone(viewerTimeZone);
  const nowOffsetPx = minToPx(nowInTz.totalMinutes);
  const isDayToday = useCallback(
    (d: Date) => format(d, "yyyy-MM-dd") === nowInTz.dateStr,
    [nowInTz.dateStr]
  );

  const hourStep = hourWidth < 24 ? 4 : hourWidth < 34 ? 2 : 1;

  const persistPosition = useCallback(() => {
    if (persistPositionTimerRef.current !== null) {
      clearTimeout(persistPositionTimerRef.current);
      persistPositionTimerRef.current = null;
    }
    if (pendingDayOffsetRef.current !== null) {
      localStorage.setItem(STORAGE_DAY_OFFSET_KEY, String(pendingDayOffsetRef.current));
      pendingDayOffsetRef.current = null;
    }
  }, []);

  // Move only the minimap overlay; scrolling must not rerender the calendar.
  const updateViewportMetrics = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const totalW = Math.max(1, el.scrollWidth);
    const start = Math.max(0, Math.min(1, el.scrollLeft / totalW));
    const width = Math.max(0.03, Math.min(1 - start, el.clientWidth / totalW));
    const viewport = minimapViewportRef.current;
    if (viewport) {
      viewport.style.transform = `translateX(${start * 100}%)`;
      // The outer overlay spans the minimap, so translation uses minimap width.
      viewport.style.setProperty("--viewport-width", `${width * 100}%`);
    }

    const dayOffset = el.scrollLeft / dayWidth;
    currentDayOffsetRef.current = dayOffset;
    pendingDayOffsetRef.current = dayOffset;
    if (persistPositionTimerRef.current !== null) {
      clearTimeout(persistPositionTimerRef.current);
    }
    persistPositionTimerRef.current = setTimeout(persistPosition, 200);
    onScrollDayOffsetChange?.(dayOffset);
  }, [dayWidth, onScrollDayOffsetChange, persistPosition]);

  useEffect(() => {
    window.addEventListener("pagehide", persistPosition);
    return () => {
      window.removeEventListener("pagehide", persistPosition);
      persistPosition();
    };
  }, [persistPosition]);

  // Persist hourWidth in localStorage and preserve the currently viewed point when zooming
  useLayoutEffect(() => {
    localStorage.setItem(STORAGE_HOUR_WIDTH_KEY, String(hourWidth));
    if (prevHourWidthRef.current !== hourWidth) {
      const el = scrollContainerRef.current;
      if (el) {
        const newDayWidth = hourWidth * 24;
        if (wheelZoomAnchorRef.current) {
          const { dayOffsetAtCursor, mouseX } = wheelZoomAnchorRef.current;
          el.scrollLeft = Math.max(0, dayOffsetAtCursor * newDayWidth - mouseX);
          wheelZoomAnchorRef.current = null;
        } else {
          el.scrollLeft = currentDayOffsetRef.current * newDayWidth;
        }
      }
      prevHourWidthRef.current = hourWidth;
      updateViewportMetrics();
    }
  }, [hourWidth, updateViewportMetrics]);

  // Mouse wheel over timeline -> Shift+Scroll scrolls horizontally; normal wheel zooms anchored at cursor
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      stopInertia();

      // Ctrl + Wheel: zoom timeline anchored at cursor position
      if (e.ctrlKey || e.metaKey) {
        const rect = el.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;

        setHourWidth((prevW) => {
          const delta = e.deltaY < 0 ? 4 : -4;
          const nextW = Math.max(MIN_HOUR_WIDTH, Math.min(MAX_HOUR_WIDTH, prevW + delta));
          if (nextW !== prevW) {
            const oldDayWidth = prevW * 24;
            const dayOffsetAtCursor = (el.scrollLeft + mouseX) / oldDayWidth;
            wheelZoomAnchorRef.current = { dayOffsetAtCursor, mouseX };
          }
          return nextW;
        });
        return;
      }

      // Regular Wheel (or Shift + Wheel / trackpad horizontal): scroll horizontally
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      el.scrollLeft += delta;
    };

    el.addEventListener("wheel", handleWheel, { passive: false });
    return () => el.removeEventListener("wheel", handleWheel);
  }, [stopInertia]);

  const handleMemberMouseDown = (
    e: React.MouseEvent<HTMLDivElement>,
    memberId: number,
    index: number
  ) => {
    if (e.button !== 0 || members.length <= 1) return;
    stopInertia();
    suppressMemberClickRef.current = false;
    memberDragRef.current = {
      memberId,
      startIndex: index,
      targetIndex: index,
      startY: e.clientY,
      offsetY: 0,
      hasMoved: false,
      memberIds: members.map((m) => m.id),
    };
  };

  const getRowDragStyle = (idx: number): React.CSSProperties | undefined => {
    if (!memberDragState) return undefined;
    const { startIndex, targetIndex, offsetY } = memberDragState;
    if (idx === startIndex) {
      return {
        transform: `translate3d(0, ${offsetY}px, 0)`,
        zIndex: 30,
        transition: "none",
      };
    }
    let shiftY = 0;
    if (startIndex < targetIndex && idx > startIndex && idx <= targetIndex) {
      shiftY = -MEMBER_ROW_HEIGHT;
    } else if (startIndex > targetIndex && idx >= targetIndex && idx < startIndex) {
      shiftY = MEMBER_ROW_HEIGHT;
    }
    return {
      transform: `translate3d(0, ${shiftY}px, 0)`,
      transition: "transform 150ms cubic-bezier(0.2, 0, 0, 1)",
    };
  };

  // LMB drag-to-scroll with momentum/inertia on release
  const handleTimelineMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    stopInertia();

    isPointerDownRef.current = true;
    hasDraggedRef.current = false;
    dragStartXRef.current = e.clientX;
    dragStartScrollLeftRef.current = scrollContainerRef.current?.scrollLeft ?? 0;
    lastPointerXRef.current = e.clientX;
    velocitySamplesRef.current = [{ x: e.clientX, t: performance.now() }];
  };

  useEffect(() => {
    const applyDragScroll = () => {
      dragRafRef.current = null;
      const scroller = scrollContainerRef.current;
      if (!scroller) return;
      scroller.scrollLeft =
        dragStartScrollLeftRef.current - (lastPointerXRef.current - dragStartXRef.current);
    };

    const handleMouseMove = (e: MouseEvent) => {
      const mDrag = memberDragRef.current;
      if (mDrag) {
        const rawDeltaY = e.clientY - mDrag.startY;
        if (!mDrag.hasMoved && Math.abs(rawDeltaY) > 4) {
          mDrag.hasMoved = true;
        }
        if (mDrag.hasMoved) {
          const minDeltaY = -mDrag.startIndex * MEMBER_ROW_HEIGHT;
          const maxDeltaY =
            (mDrag.memberIds.length - 1 - mDrag.startIndex) * MEMBER_ROW_HEIGHT;
          const clampedY = Math.max(minDeltaY, Math.min(maxDeltaY, rawDeltaY));
          const targetIndex = Math.max(
            0,
            Math.min(
              mDrag.memberIds.length - 1,
              Math.round((mDrag.startIndex * MEMBER_ROW_HEIGHT + clampedY) / MEMBER_ROW_HEIGHT)
            )
          );
          mDrag.offsetY = clampedY;
          mDrag.targetIndex = targetIndex;
          setMemberDragState({
            memberId: mDrag.memberId,
            startIndex: mDrag.startIndex,
            targetIndex,
            offsetY: clampedY,
          });
        }
        return;
      }

      if (isDraggingMinimapRef.current) {
        const mini = minimapRef.current;
        const scroller = scrollContainerRef.current;
        if (!mini || !scroller) return;
        const rect = mini.getBoundingClientRect();
        const clickRatio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        const visibleRatio = scroller.clientWidth / Math.max(1, scroller.scrollWidth);
        const targetStartRatio = Math.max(
          0,
          Math.min(Math.max(0, 1 - visibleRatio), clickRatio - visibleRatio / 2)
        );
        scroller.scrollLeft = targetStartRatio * scroller.scrollWidth;
        return;
      }

      if (!isPointerDownRef.current) return;
      const scroller = scrollContainerRef.current;
      if (!scroller) return;

      const dxFromStart = Math.abs(e.clientX - dragStartXRef.current);
      if (!hasDraggedRef.current && dxFromStart > 3) {
        hasDraggedRef.current = true;
        setIsDraggingTimeline(true);
      }

      lastPointerXRef.current = e.clientX;
      if (dragRafRef.current === null) {
        dragRafRef.current = requestAnimationFrame(applyDragScroll);
      }

      const now = performance.now();
      const samples = velocitySamplesRef.current;
      samples.push({ x: e.clientX, t: now });
      // Keep samples within the last 110ms so a brief pause before releasing still retains momentum
      while (samples.length > 0 && now - samples[0].t > 110) {
        samples.shift();
      }
    };

    const handleMouseUp = () => {
      const mDrag = memberDragRef.current;
      if (mDrag) {
        memberDragRef.current = null;
        if (mDrag.hasMoved) {
          suppressMemberClickRef.current = true;
          const { startIndex, targetIndex, memberIds } = mDrag;
          if (targetIndex !== startIndex && onReorderMembersRef.current) {
            const nextIds = [...memberIds];
            const [movedId] = nextIds.splice(startIndex, 1);
            nextIds.splice(targetIndex, 0, movedId);
            onReorderMembersRef.current(nextIds);
          }
          setMemberDragState(null);
        }
        return;
      }

      if (isDraggingMinimapRef.current) {
        isDraggingMinimapRef.current = false;
      }

      if (!isPointerDownRef.current) return;
      // Flush the latest movement before starting inertia, even between frames.
      if (dragRafRef.current !== null) {
        cancelAnimationFrame(dragRafRef.current);
        applyDragScroll();
      }
      isPointerDownRef.current = false;
      setIsDraggingTimeline(false);

      const scroller = scrollContainerRef.current;
      if (!scroller || !hasDraggedRef.current) return;

      const now = performance.now();
      // Keep samples from the last 110ms (covers both releasing in motion and releasing a moment after stopping)
      const recent = velocitySamplesRef.current.filter((s) => now - s.t <= 110);
      if (recent.length >= 2) {
        const first = recent[0];
        const last = recent[recent.length - 1];
        const dt = Math.max(8, last.t - first.t);
        // Velocity in px per 16.67ms frame (positive = scrolling right)
        let velocityPxPerFrame = ((first.x - last.x) / dt) * 16.67;
        // Clamp extreme flick speeds for smooth control
        velocityPxPerFrame = Math.max(-90, Math.min(90, velocityPxPerFrame));

        if (Math.abs(velocityPxPerFrame) > 0.6) {
          let lastFrameTime = performance.now();

          const stepInertia = (frameNow: number) => {
            const el = scrollContainerRef.current;
            if (!el) return;

            const frameDt = Math.min(50, Math.max(1, frameNow - lastFrameTime));
            lastFrameTime = frameNow;
            const timeScale = frameDt / 16.67;

            const prevScroll = el.scrollLeft;
            el.scrollLeft += velocityPxPerFrame * timeScale;
            velocityPxPerFrame *= Math.pow(0.93, timeScale);

            const hitEdge =
              Math.abs(el.scrollLeft - prevScroll) < 0.1 && Math.abs(velocityPxPerFrame) > 1;

            if (Math.abs(velocityPxPerFrame) > 0.35 && !hitEdge) {
              inertiaRafRef.current = requestAnimationFrame(stepInertia);
            } else {
              inertiaRafRef.current = null;
              updateViewportMetrics();
              persistPosition();
            }
          };

          inertiaRafRef.current = requestAnimationFrame(stepInertia);
        }
      }
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      if (dragRafRef.current !== null) {
        cancelAnimationFrame(dragRafRef.current);
        dragRafRef.current = null;
      }
    };
  }, [updateViewportMetrics, persistPosition]);

  useEffect(() => {
    return () => stopInertia();
  }, [stopInertia]);

  // Scroll positioning on initial mount, "Сегодня", week navigation, or 7/14 day switch
  useLayoutEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    stopInertia();

    const applyScroll = () => {
      if (!scrollContainerRef.current) return;
      const scroller = scrollContainerRef.current;

      if (scrollCommand?.type === "preserve-day" && scrollCommand.targetDayOffset !== undefined) {
        scroller.scrollLeft = scrollCommand.targetDayOffset * dayWidth;
      } else if (scrollCommand?.type === "today") {
        const todayIdx = days.findIndex((d) => isDayToday(d));
        if (todayIdx !== -1) {
          scroller.scrollLeft = todayIdx * dayWidth;
        } else {
          scroller.scrollLeft = 0;
        }
      } else if (scrollCommand?.type === "week-nav") {
        // При переключении недели (< или >) НЕ перескакиваем на сегодняшний день, сохраняем текущую позицию
        scroller.scrollLeft = currentDayOffsetRef.current * dayWidth;
      }
      updateViewportMetrics();
    };

    applyScroll();
    const rafId = requestAnimationFrame(applyScroll);
    return () => cancelAnimationFrame(rafId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollCommand?.seq, days]);

  useEffect(() => {
    updateViewportMetrics();
    window.addEventListener("resize", updateViewportMetrics);
    return () => window.removeEventListener("resize", updateViewportMetrics);
  }, [updateViewportMetrics, days.length, members.length]);

  const scrollToMinimapClientX = useCallback(
    (clientX: number) => {
      stopInertia();
      const mini = minimapRef.current;
      const scroller = scrollContainerRef.current;
      if (!mini || !scroller) return;
      const rect = mini.getBoundingClientRect();
      const clickRatio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const visibleRatio = scroller.clientWidth / Math.max(1, scroller.scrollWidth);
      const targetStartRatio = Math.max(
        0,
        Math.min(Math.max(0, 1 - visibleRatio), clickRatio - visibleRatio / 2)
      );
      scroller.scrollLeft = targetStartRatio * scroller.scrollWidth;
    },
    [stopInertia]
  );

  const handleToggleAll = () => {
    if (allSelected) {
      onSelectCombinationPreset([]);
    } else {
      onSelectCombinationPreset(allMemberIds);
    }
  };

  return (
    <TooltipProvider delayDuration={100}>
      <div className="rounded-lg border border-border bg-card overflow-hidden select-none">
        {/* ДВУХКОЛОНОЧНЫЙ МАКЕТ: Слева фиксированные участники, справа изолированный скролл таймлайна */}
        <div className="flex">
          {/* ЛЕВАЯ КОЛОНКА: Участники (таймлайн сюда физически не заходит) */}
          <div
            style={{ width: `${MEMBER_COLUMN_WIDTH}px`, minWidth: `${MEMBER_COLUMN_WIDTH}px` }}
            className="shrink-0 border-r border-border bg-card flex flex-col z-20"
          >
            {/* Шапка левой колонки (высота h-[52px] совпадает с шапкой таймлайна) */}
            <div className="h-[52px] border-b border-border bg-card px-3 flex items-center justify-between gap-2 shrink-0">
              <button
                type="button"
                onClick={handleToggleAll}
                className="flex items-center gap-2 text-xs font-medium text-foreground hover:text-primary cursor-pointer"
              >
                <div
                  className={`size-4 rounded-[4px] border flex items-center justify-center ${
                    allSelected
                      ? "bg-primary border-primary text-primary-foreground"
                      : isFilterActive
                      ? "bg-primary/20 border-primary text-foreground"
                      : "border-input bg-background"
                  }`}
                >
                  {(allSelected || isFilterActive) && <Check className="size-3 stroke-[2.5]" />}
                </div>
                <span>Участники ({members.length})</span>
              </button>

              {isFilterActive && (
                <button
                  type="button"
                  onClick={() => onSelectCombinationPreset([])}
                  className="text-[11px] text-muted-foreground hover:text-foreground cursor-pointer"
                >
                  Сброс
                </button>
              )}
            </div>

            {/* Список карточек участников (с поддержкой баннеров PNG/GIF, аватарок и вертикального перетаскивания) */}
            <div className="relative flex flex-col overflow-hidden">
              {members.map((member, memberIdx) => {
                const isSelectedInCombo = selectedMemberIds.includes(member.id);
                const isDimmed = isFilterActive && !isSelectedInCombo;
                const hasBanner = Boolean(member.banner_url);
                const isBeingDragged = memberDragState?.memberId === member.id;

                return (
                  <div
                    key={member.id}
                    data-testid={`member-card-${member.id}`}
                    onMouseDown={(e) => handleMemberMouseDown(e, member.id, memberIdx)}
                    onClick={() => {
                      if (suppressMemberClickRef.current) {
                        suppressMemberClickRef.current = false;
                        return;
                      }
                      onToggleMemberFilter(member.id);
                    }}
                    style={{
                      height: `${MEMBER_ROW_HEIGHT}px`,
                      ...getRowDragStyle(memberIdx),
                    }}
                    className={`relative border-b border-border last:border-b-0 px-3 flex items-center justify-between gap-2 shrink-0 overflow-hidden ${
                      memberDragState
                        ? isBeingDragged
                          ? "cursor-grabbing shadow-lg ring-1 ring-primary/60"
                          : "cursor-grabbing"
                        : members.length > 1
                        ? "cursor-grab"
                        : "cursor-pointer"
                    } ${
                      !hasBanner
                        ? isSelectedInCombo
                          ? "bg-accent hover:bg-accent"
                          : "bg-card hover:bg-muted"
                        : "bg-card"
                    } ${isDimmed ? "opacity-35" : "opacity-100"}`}
                  >
                    {/* Баннер и затемняющая подложка в одном слое на всю площадь без 1px зазора снизу */}
                    {hasBanner && (
                      <div className="DataBannerLayer absolute -inset-px pointer-events-none">
                        <img
                          src={member.banner_url!}
                          alt=""
                          draggable={false}
                          loading="lazy"
                          decoding="async"
                          className="size-full object-cover"
                        />
                        <div
                          className={`absolute inset-0 ${
                            isSelectedInCombo
                              ? "bg-gradient-to-r from-background/85 via-background/60 to-background/25 ring-1 ring-inset ring-primary/60"
                              : "bg-gradient-to-r from-background/85 via-background/65 to-background/30 hover:from-background/75 hover:via-background/55"
                          }`}
                        />
                      </div>
                    )}

                    <div className="relative z-10 flex items-center gap-2.5 min-w-0">
                      <div
                        className={`size-4 rounded-[4px] border flex items-center justify-center shrink-0 ${
                          isSelectedInCombo
                            ? "bg-primary border-primary text-primary-foreground"
                            : "border-input bg-background/90"
                        }`}
                      >
                        {isSelectedInCombo && <Check className="size-3 stroke-[2.5]" />}
                      </div>

                      <div
                        className="size-6 rounded-full overflow-hidden flex items-center justify-center text-white font-semibold text-[11px] shrink-0"
                        style={{
                          backgroundColor: member.avatar_url ? undefined : member.avatar_color,
                        }}
                      >
                        {member.avatar_url ? (
                          <img
                            src={member.avatar_url}
                            alt={member.display_name}
                            draggable={false}
                            loading="lazy"
                            decoding="async"
                            className="size-full object-cover"
                          />
                        ) : (
                          member.display_name.slice(0, 1).toUpperCase()
                        )}
                      </div>

                      <div className="min-w-0">
                        <div className="text-sm font-medium text-foreground truncate leading-tight drop-shadow-xs">
                          {member.display_name.replace(" (Вы)", "")}
                        </div>
                        <div className="text-[11px] text-muted-foreground font-mono truncate drop-shadow-xs">
                          @{member.username}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* ПРАВАЯ КОЛОНКА: ПРОКРУЧИВАЕМЫЙ ТАЙМЛАЙН (Drag LMB + Inertia + Wheel Zoom, без скроллбара) */}
          <div
            ref={scrollContainerRef}
            onScroll={updateViewportMetrics}
            onMouseDown={handleTimelineMouseDown}
            className={`flex-1 min-w-0 overflow-x-auto overflow-y-hidden no-scrollbar ${
              isDraggingTimeline ? "cursor-grabbing" : "cursor-grab"
            }`}
          >
            <div
              className="relative flex flex-col"
              style={{ width: `${totalTimelineWidth}px` }}
            >
              {/* ШАПКА ТАЙМЛАЙНА: Горизонтальная шкала дней и часов (h-[52px]) */}
              <div className="flex h-[52px] border-b border-border bg-muted/30 shrink-0">
                {days.map((day) => {
                  const dateStr = format(day, "yyyy-MM-dd");
                  const today = isDayToday(day);
                  const weekend = isWeekend(day);

                  return (
                    <div
                      key={dateStr}
                      style={{ width: `${dayWidth}px`, minWidth: `${dayWidth}px` }}
                      className="border-r border-border flex flex-col h-full"
                    >
                      {/* Верхний уровень: День недели и дата */}
                      <div
                        className={`h-7 px-3 border-b border-border/60 flex items-center justify-between shrink-0 ${
                          today
                            ? "bg-foreground text-background"
                            : weekend
                            ? "bg-muted/50 text-foreground"
                            : "bg-card/40 text-foreground"
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <span
                            className={`text-xs lowercase ${
                              today ? "font-bold text-background" : "font-semibold text-foreground"
                            }`}
                          >
                            {format(day, "EEEEEE, d MMMM", { locale: ru })}
                          </span>
                          {today && (
                            <span className="text-[10px] font-medium px-1.5 py-0.2 rounded bg-background text-foreground">
                              сегодня
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Нижний уровень: Часы 0:00 .. 23:00 */}
                      <div
                        className="relative flex-1 bg-background/60"
                        style={hourGridStyle(35)}
                      >
                        {HOURS_24.filter((h) => h % hourStep === 0).map((h) => (
                          <div
                            key={h}
                            style={{ left: `${h * hourWidth + 4}px` }}
                            className="absolute inset-y-0 flex items-center"
                          >
                            <span className="text-[10px] font-mono text-foreground/80 leading-none">
                              {h}
                              <span className="text-[8px] align-top text-muted-foreground/45 ml-px">
                                :00
                              </span>
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* СТРОКИ ТАЙМЛАЙНОВ УЧАСТНИКОВ */}
              <div className="relative flex flex-col overflow-hidden">
                {members.map((member, memberIdx) => {
                  const isSelectedInCombo = selectedMemberIds.includes(member.id);
                  const isDimmed = isFilterActive && !isSelectedInCombo;
                  const isMe = member.id === currentUser.id;
                  const busyBlocks = busyBlocksByMember[member.id] || [];
                  const isBeingDragged = memberDragState?.memberId === member.id;

                  return (
                    <div
                      key={member.id}
                      className={`relative border-b border-border/40 last:border-b-0 bg-background/40 transition-opacity duration-150 ${
                        isDimmed ? "opacity-35" : "opacity-100"
                      } ${isBeingDragged ? "bg-background/90 shadow-md" : ""}`}
                      style={{
                        height: `${MEMBER_ROW_HEIGHT}px`,
                        width: `${totalTimelineWidth}px`,
                        minWidth: `${totalTimelineWidth}px`,
                        ...getRowDragStyle(memberIdx),
                      }}
                    >
                      {/* Слой 1: Сетка дней и часов (кликабельно ТОЛЬКО для своей строки isMe при отсутствии перетаскивания) */}
                      <div className="absolute inset-0 flex">
                        {days.map((day) => {
                          const dateStr = format(day, "yyyy-MM-dd");
                          const today = isDayToday(day);
                          return (
                            <div
                              key={dateStr}
                              onClick={() => {
                                if (isMe && !hasDraggedRef.current) {
                                  onCellClick(member, day);
                                }
                              }}
                              style={{
                                width: `${dayWidth}px`,
                                minWidth: `${dayWidth}px`,
                                ...hourGridStyle(25),
                              }}
                              className={`relative h-full border-r border-border flex ${
                                isDraggingTimeline
                                  ? "cursor-grabbing"
                                  : isMe
                                  ? "cursor-pointer hover:bg-white/[0.02]"
                                  : "cursor-grab"
                              }`}
                            >
                              {today && (
                                <div
                                  style={{ left: `${nowOffsetPx}px` }}
                                  className="absolute inset-y-0 w-[2px] bg-zinc-400/80 z-20 pointer-events-none"
                                />
                              )}
                            </div>
                          );
                        })}
                      </div>

                      {/* Слой 2: Непрерывные зелёные области общих свободных окон на всю высоту строки */}
                      {isFilterActive &&
                        isSelectedInCombo &&
                        continuousFreeWindows.map((win, wIdx) => {
                          const leftPx = minToPx(win.startMin);
                          const widthPx = minToPx(win.endMin - win.startMin);
                          return (
                            <div
                              key={`free-${wIdx}`}
                              style={{ left: `${leftPx}px`, width: `${widthPx}px` }}
                              className="absolute -top-px -bottom-px bg-emerald-500/20 border-x border-emerald-500/50 pointer-events-none flex items-center justify-between px-1.5 overflow-hidden z-[5]"
                            >
                              {widthPx >= 75 && (
                                <>
                                  <span className="text-[10px] font-mono text-emerald-400 leading-none">
                                    {win.startTimeLabel}
                                  </span>
                                  <span className="text-[10px] font-mono text-emerald-400 leading-none">
                                    {win.endTimeLabel}
                                  </span>
                                </>
                              )}
                            </div>
                          );
                        })}

                      {/* Слой 3: Отдельные интервалы, пересечения на разных уровнях */}
                      {busyBlocks.map((block, bIdx) => {
                        const leftPx = minToPx(block.startMin);
                        const widthPx = Math.max(4, minToPx(block.endMin - block.startMin));
                        const dayIndex = Math.min(
                          days.length - 1,
                          Math.floor(block.startMin / 1440)
                        );
                        const blockDay = days[dayIndex];

                        return (
                          <Tooltip key={bIdx}>
                            <TooltipTrigger asChild>
                              <div
                                onClick={() => {
                                  if (isMe && !hasDraggedRef.current) {
                                    onCellClick(member, block.sourceDate || blockDay, block.groupId);
                                  }
                                }}
                                style={{
                                  left: `${leftPx}px`,
                                  width: `${widthPx}px`,
                                  top: `${(block.lane / block.laneCount) * 100}%`,
                                  height: `${100 / block.laneCount}%`,
                                  ...(block.style
                                    ? getTimelineBlockStyle(block.style)
                                    : blockStylesByMember[member.id]),
                                }}
                                className={`absolute z-10 rounded-[2px] flex items-center gap-1.5 px-1.5 overflow-clip text-white ${
                                  isDraggingTimeline
                                    ? "cursor-grabbing "
                                    : isMe
                                    ? "cursor-pointer hover:brightness-110 "
                                    : "cursor-grab "
                                }`}
                              >
                                {widthPx >= 64 ? (
                                  <>
                                    <span className="text-[10px] font-mono font-medium leading-none shrink-0">
                                      {block.startTimeLabel}
                                    </span>
                                    <span className="sticky left-1.5 text-[10px] font-medium truncate opacity-95">
                                      {block.note || block.groupName}
                                    </span>
                                    <span className="ml-auto text-[10px] font-mono font-medium leading-none shrink-0 pl-1">
                                      {block.endTimeLabel}
                                    </span>
                                  </>
                                ) : (
                                  widthPx >= 34 && (
                                    <span className="sticky left-1 text-[9px] font-mono font-medium leading-none truncate">
                                      {block.note || block.groupName || block.startTimeLabel}
                                    </span>
                                  )
                                )}
                              </div>
                            </TooltipTrigger>
                            <TooltipContent>
                              <div className="font-medium flex items-center gap-1.5">
                                <span>{member.display_name.replace(" (Вы)", "")}</span>
                                {block.groupName && (
                                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-normal">
                                    {block.groupName}
                                  </span>
                                )}
                              </div>
                              <div className="font-mono text-[11px]">
                                {block.startTimeLabel} – {block.endTimeLabel}
                              </div>
                              {block.note && (
                                <div className="text-[11px] opacity-90">«{block.note}»</div>
                              )}
                            </TooltipContent>
                          </Tooltip>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        {/* НИЖНЯЯ ПАНЕЛЬ: УПРАВЛЕНИЕ МАСШТАБОМ ТАЙМЛАЙНА + МИНИКАРТА КАК В VSCODE */}
        <div className="border-t border-border bg-card flex items-stretch h-12">
          {/* Слева под колонкой участников: ползунок и кнопки масштаба таймлайна */}
          <div
            style={{ width: `${MEMBER_COLUMN_WIDTH}px`, minWidth: `${MEMBER_COLUMN_WIDTH}px` }}
            className="border-r border-border px-3 flex items-center justify-between gap-2 shrink-0 bg-card"
          >
            <span className="text-[11px] font-medium text-muted-foreground shrink-0">
              Масштаб
            </span>
            <div className="flex items-center gap-1.5 flex-1">
              <button
                type="button"
                onClick={() => setHourWidth((w) => Math.max(MIN_HOUR_WIDTH, w - 4))}
                className="text-muted-foreground hover:text-foreground cursor-pointer p-0.5"
                title="Уменьшить"
              >
                <ZoomOut className="size-3.5" />
              </button>
              <input
                type="range"
                min={MIN_HOUR_WIDTH}
                max={MAX_HOUR_WIDTH}
                step={2}
                value={hourWidth}
                onChange={(e) => setHourWidth(Number(e.target.value))}
                className="w-full h-1 bg-muted rounded-lg appearance-none cursor-pointer accent-primary"
              />
              <button
                type="button"
                onClick={() => setHourWidth((w) => Math.min(MAX_HOUR_WIDTH, w + 4))}
                className="text-muted-foreground hover:text-foreground cursor-pointer p-0.5"
                title="Увеличить"
              >
                <ZoomIn className="size-3.5" />
              </button>
            </div>
          </div>

          {/* Справа: Интерактивная миникарта (VSCode Minimap) всего диапазона дней */}
          <div
            ref={minimapRef}
            onMouseDown={(e) => {
              isDraggingMinimapRef.current = true;
              scrollToMinimapClientX(e.clientX);
            }}
            className="relative flex-1 bg-background/80 cursor-ew-resize overflow-hidden"
            title="Миникарта таймлайна (кликните или перетащите для быстрой навигации)"
          >
            {/* Деления дней на миникарте */}
            <div className="absolute inset-0 flex pointer-events-none">
              {days.map((d) => (
                <div
                  key={format(d, "yyyy-MM-dd")}
                  style={{ width: `${100 / days.length}%` }}
                  className="h-full border-r border-border/40 flex items-end pb-0.5 pl-1"
                >
                  <span className="text-[9px] font-mono text-muted-foreground/60 leading-none">
                    {format(d, "EEEEEE d", { locale: ru })}
                  </span>
                </div>
              ))}
            </div>

            {/* Зелёные зоны свободных окон на миникарте */}
            {isFilterActive &&
              continuousFreeWindows.map((win, idx) => {
                const leftPct = (win.startMin / totalMinutes) * 100;
                const widthPct = ((win.endMin - win.startMin) / totalMinutes) * 100;
                return (
                  <div
                    key={`mini-free-${idx}`}
                    style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                    className="absolute inset-y-0 bg-emerald-500/20 pointer-events-none"
                  />
                );
              })}

            {/* Мини-дорожки красных блоков занятости каждого участника */}
            <div className="absolute inset-x-0 top-1 bottom-3.5 flex flex-col justify-around pointer-events-none">
              {members.map((member) => {
                const blocks = busyBlocksByMember[member.id] || [];
                const isSelectedInCombo = selectedMemberIds.includes(member.id);
                const isDimmed = isFilterActive && !isSelectedInCombo;
                return (
                  <div
                    key={`mini-row-${member.id}`}
                    className={`relative w-full h-[3px] ${isDimmed ? "opacity-30" : "opacity-90"}`}
                  >
                    {blocks.map((b, i) => {
                      const leftPct = (b.startMin / totalMinutes) * 100;
                      const widthPct = Math.max(0.3, ((b.endMin - b.startMin) / totalMinutes) * 100);
                      return (
                        <div
                          key={i}
                          style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                          className={`absolute inset-y-0 ${
                            member.id === currentUser.id
                              ? "bg-rose-500"
                              : "bg-rose-800"
                          }`}
                        />
                      );
                    })}
                  </div>
                );
              })}
            </div>

            {/* Ползунок-рамка видимой области (VSCode Minimap Viewport Slider) */}
            <div
              ref={minimapViewportRef}
              className="absolute inset-0 pointer-events-none"
            >
              <div
                style={{ width: "var(--viewport-width, 25%)" }}
                className="absolute inset-y-0 left-0 bg-foreground/10 border-x-2 border-primary/80 transition-[width] duration-75"
              />
            </div>
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
};
