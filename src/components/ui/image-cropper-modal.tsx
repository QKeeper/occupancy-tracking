import React, { useState, useRef, useEffect, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ZoomIn, ZoomOut, RotateCcw } from "lucide-react";

export interface NormalizedCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ImageCropperModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  imageSrc: string | null;
  kind: "avatar" | "banner";
  onConfirmCrop: (crop: NormalizedCrop) => Promise<void> | void;
}

export const ImageCropperModal: React.FC<ImageCropperModalProps> = ({
  open,
  onOpenChange,
  imageSrc,
  kind,
  onConfirmCrop,
}) => {
  // Crop box dimensions in px (banner uses unified 18:5 / 3.6:1 aspect ratio)
  const cropBoxWidth = kind === "avatar" ? 220 : 432;
  const cropBoxHeight = kind === "avatar" ? 220 : 120;

  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number }>({
    w: cropBoxWidth,
    h: cropBoxHeight,
  });
  const [zoom, setZoom] = useState<number>(1);
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const dragStartRef = useRef<{ x: number; y: number; panX: number; panY: number }>({
    x: 0,
    y: 0,
    panX: 0,
    panY: 0,
  });
  const stageRef = useRef<HTMLDivElement>(null);

  // Base scale so that at zoom = 1 the image covers the cropBox completely
  const baseScale = Math.max(
    cropBoxWidth / Math.max(1, naturalSize.w),
    cropBoxHeight / Math.max(1, naturalSize.h)
  );

  const renderedW = naturalSize.w * baseScale * zoom;
  const renderedH = naturalSize.h * baseScale * zoom;

  const clampPan = useCallback(
    (rawX: number, rawY: number, currentZoom: number, natW: number, natH: number) => {
      const bScale = Math.max(
        cropBoxWidth / Math.max(1, natW),
        cropBoxHeight / Math.max(1, natH)
      );
      const rW = natW * bScale * currentZoom;
      const rH = natH * bScale * currentZoom;
      const maxX = Math.max(0, (rW - cropBoxWidth) / 2);
      const maxY = Math.max(0, (rH - cropBoxHeight) / 2);
      return {
        x: Math.max(-maxX, Math.min(maxX, rawX)),
        y: Math.max(-maxY, Math.min(maxY, rawY)),
      };
    },
    [cropBoxWidth, cropBoxHeight]
  );

  useEffect(() => {
    if (open) {
      setZoom(1);
      setPan({ x: 0, y: 0 });
      setSubmitting(false);
    }
  }, [open, imageSrc]);

  const handleImageLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    const w = img.naturalWidth || cropBoxWidth;
    const h = img.naturalHeight || cropBoxHeight;
    setNaturalSize({ w, h });
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  const handleUpdateZoom = useCallback(
    (nextZoom: number) => {
      const clampedZoom = Math.max(1, Math.min(4, Math.round(nextZoom * 100) / 100));
      setZoom(clampedZoom);
      setPan((prev) =>
        clampPan(prev.x, prev.y, clampedZoom, naturalSize.w, naturalSize.h)
      );
    },
    [clampPan, naturalSize.w, naturalSize.h]
  );

  useEffect(() => {
    const el = stageRef.current;
    if (!el || !open) return;
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      const delta = e.deltaY < 0 ? 0.12 : -0.12;
      handleUpdateZoom(zoom + delta);
    };
    el.addEventListener("wheel", handleWheel, { passive: false });
    return () => el.removeEventListener("wheel", handleWheel);
  }, [open, zoom, handleUpdateZoom]);

  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    setIsDragging(true);
    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      panX: pan.x,
      panY: pan.y,
    };
  };

  useEffect(() => {
    if (!isDragging) return;
    const handleMouseMove = (e: MouseEvent) => {
      const dx = e.clientX - dragStartRef.current.x;
      const dy = e.clientY - dragStartRef.current.y;
      setPan(
        clampPan(
          dragStartRef.current.panX + dx,
          dragStartRef.current.panY + dy,
          zoom,
          naturalSize.w,
          naturalSize.h
        )
      );
    };
    const handleMouseUp = () => {
      setIsDragging(false);
    };
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDragging, zoom, naturalSize.w, naturalSize.h, clampPan]);

  const handleApply = async () => {
    const clamped = clampPan(pan.x, pan.y, zoom, naturalSize.w, naturalSize.h);
    const leftInRendered = (renderedW - cropBoxWidth) / 2 - clamped.x;
    const topInRendered = (renderedH - cropBoxHeight) / 2 - clamped.y;

    const normX = Math.max(0, Math.min(1, leftInRendered / Math.max(1, renderedW)));
    const normY = Math.max(0, Math.min(1, topInRendered / Math.max(1, renderedH)));
    const normW = Math.max(0.01, Math.min(1 - normX, cropBoxWidth / Math.max(1, renderedW)));
    const normH = Math.max(0.01, Math.min(1 - normY, cropBoxHeight / Math.max(1, renderedH)));

    setSubmitting(true);
    try {
      await onConfirmCrop({
        x: normX,
        y: normY,
        width: normW,
        height: normH,
      });
      onOpenChange(false);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>
            {kind === "avatar" ? "Кадрирование аватарки" : "Кадрирование баннера"}
          </DialogTitle>
          <DialogDescription className="text-xs">
            Перетаскивайте изображение мышью и используйте ползунок или колёсико для масштаба
          </DialogDescription>
        </DialogHeader>

        {/* Интерактивная область кадрирования */}
        <div
          ref={stageRef}
          onMouseDown={handleMouseDown}
          className={`relative h-[280px] w-full rounded-xl bg-black/90 overflow-hidden select-none ${
            isDragging ? "cursor-grabbing" : "cursor-grab"
          }`}
        >
          {/* Слой 1: Центрированное изображение (не сжимается flex-контейнером) */}
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            {imageSrc && (
              <img
                src={imageSrc}
                alt="Кадрирование"
                onLoad={handleImageLoad}
                draggable={false}
                style={{
                  width: `${renderedW}px`,
                  height: `${renderedH}px`,
                  maxWidth: "none",
                  maxHeight: "none",
                  transform: `translate3d(${pan.x}px, ${pan.y}px, 0)`,
                }}
                className="shrink-0 pointer-events-none select-none object-fill"
              />
            )}
          </div>

          {/* Слой 2: Центрированная затемняющая маска с окном кадрирования поверх изображения */}
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div
              style={{
                width: `${cropBoxWidth}px`,
                height: `${cropBoxHeight}px`,
                boxShadow: "0 0 0 9999px rgba(0, 0, 0, 0.68)",
              }}
              className={`shrink-0 pointer-events-none border-2 border-white/90 ${
                kind === "avatar" ? "rounded-full" : "rounded-lg"
              }`}
            />
          </div>
        </div>

        {/* Ползунок масштаба и кнопка сброса */}
        <div className="flex items-center gap-3 pt-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={() => handleUpdateZoom(zoom - 0.2)}
            disabled={zoom <= 1}
            title="Уменьшить"
          >
            <ZoomOut className="size-4 text-muted-foreground" />
          </Button>

          <input
            type="range"
            min="1"
            max="4"
            step="0.02"
            value={zoom}
            onChange={(e) => handleUpdateZoom(parseFloat(e.target.value))}
            className="flex-1 h-1.5 rounded-lg accent-primary cursor-pointer"
          />

          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={() => handleUpdateZoom(zoom + 0.2)}
            disabled={zoom >= 4}
            title="Увеличить"
          >
            <ZoomIn className="size-4 text-muted-foreground" />
          </Button>

          <span className="text-xs font-mono text-muted-foreground w-11 text-right">
            {Math.round(zoom * 100)}%
          </span>

          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setZoom(1);
              setPan({ x: 0, y: 0 });
            }}
            className="h-7 px-2 text-xs text-muted-foreground"
            title="Сбросить положение"
          >
            <RotateCcw className="size-3.5" />
            Сброс
          </Button>
        </div>

        <DialogFooter className="pt-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Отмена
          </Button>
          <Button type="button" onClick={handleApply} disabled={submitting}>
            {submitting ? "Обработка..." : "Применить"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
