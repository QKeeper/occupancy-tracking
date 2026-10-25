import React, { useId } from "react";
import { TimelineStyleConfig } from "@/types";

export const MAX_ICON_HISTORY = 15;

export const TELEGRAM_PATTERN_SYMBOLS = [
  "⚡",
  "⭐",
  "🔥",
  "❤️",
  "👑",
  "💎",
  "💀",
  "🎮",
  "🌙",
  "❄️",
  "🚀",
  "🎵",
  "🌸",
  "🍕",
  "🐱",
];

export const DEFAULT_TIMELINE_STYLE: TimelineStyleConfig = {
  bgColor: "#e11d48",
  patternColor: "#fda4af",
  patternType: "stripes",
  symbol: "⚡",
  iconScale: 1,
  iconHistory: TELEGRAM_PATTERN_SYMBOLS,
};

function hexToRgba(hex: string, alpha: number): string {
  const clean = (hex || "#e11d48").replace("#", "").trim();
  if (clean.length === 3) {
    const r = parseInt(clean[0] + clean[0], 16) || 225;
    const g = parseInt(clean[1] + clean[1], 16) || 29;
    const b = parseInt(clean[2] + clean[2], 16) || 72;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  const r = parseInt(clean.slice(0, 2), 16) || 225;
  const g = parseInt(clean.slice(2, 4), 16) || 29;
  const b = parseInt(clean.slice(4, 6), 16) || 72;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Renders a single icon (either an emoji/symbol string or a custom uploaded SVG/PNG data URL)
 * tinted into the exact `color` using an SVG SourceAlpha flood filter.
 */
export const TintedPatternIcon: React.FC<{
  symbol: string;
  color: string;
  size?: number;
}> = ({ symbol, color, size = 16 }) => {
  const rawId = useId();
  const filterId = `tint-${rawId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const isCustomImage = symbol.startsWith("data:image/");

  return React.createElement(
    "svg",
    {
      width: size,
      height: size,
      viewBox: "0 0 24 24",
      className: "shrink-0 overflow-visible pointer-events-none",
    },
    React.createElement(
      "defs",
      null,
      React.createElement(
        "filter",
        { id: filterId, x: "-25%", y: "-25%", width: "150%", height: "150%" },
        React.createElement("feFlood", {
          floodColor: color,
          floodOpacity: "1",
          result: "flood",
        }),
        React.createElement("feComposite", {
          in: "flood",
          in2: "SourceAlpha",
          operator: "in",
        })
      )
    ),
    React.createElement(
      "g",
      { filter: `url(#${filterId})` },
      isCustomImage
        ? React.createElement("image", {
            href: symbol,
            x: "2",
            y: "2",
            width: "20",
            height: "20",
            preserveAspectRatio: "xMidYMid meet",
          })
        : React.createElement(
            "text",
            {
              x: "12",
              y: "12.5",
              fontSize: "16",
              textAnchor: "middle",
              dominantBaseline: "central",
              fontFamily: "Segoe UI Emoji, Apple Color Emoji, Noto Color Emoji, sans-serif",
            },
            symbol
          )
    )
  );
};

/**
 * Generates inline CSS properties for the user's busy blocks on the timeline,
 * supporting:
 * - "none": solid/translucent background in bgColor
 * - "stripes": diagonal stripes in patternColor over bgColor
 * - "symbols": Telegram-style staggered repeating emoji/custom-icon silhouettes tinted in patternColor over bgColor
 */
export function getTimelineBlockStyle(config?: Partial<TimelineStyleConfig>): React.CSSProperties {
  const bgColor = config?.bgColor || DEFAULT_TIMELINE_STYLE.bgColor;
  const patternColor = config?.patternColor || DEFAULT_TIMELINE_STYLE.patternColor;
  const patternType = config?.patternType || DEFAULT_TIMELINE_STYLE.patternType;
  const symbol = (config?.symbol || DEFAULT_TIMELINE_STYLE.symbol).trim() || "⚡";
  const iconScale = Math.max(0.5, Math.min(2.2, Number(config?.iconScale) || 1));

  const baseBg = hexToRgba(bgColor, 0.86);
  const borderCol = hexToRgba(patternColor, 0.75);

  if (patternType === "stripes") {
    const stripeCol = hexToRgba(patternColor, 0.28);
    return {
      backgroundColor: baseBg,
      borderColor: borderCol,
      backgroundImage: `repeating-linear-gradient(135deg, ${stripeCol} 0px, ${stripeCol} 6px, transparent 6px, transparent 14px)`,
    };
  }

  if (patternType === "symbols") {
    const isCustomImage = symbol.startsWith("data:image/");
    const size1 = Math.round(13 * iconScale * 10) / 10;
    const size2 = Math.round(11 * iconScale * 10) / 10;

    let innerElements = "";
    if (isCustomImage) {
      const safeHref = symbol.replace(/"/g, "&quot;");
      const half1 = size1 / 2;
      const half2 = size2 / 2;
      innerElements = `
        <image href="${safeHref}" x="${14 - half1}" y="${13 - half1}" width="${size1}" height="${size1}" preserveAspectRatio="xMidYMid meet" transform="rotate(-14 14 13)" />
        <image href="${safeHref}" x="${40 - half2}" y="${33 - half2}" width="${size2}" height="${size2}" preserveAspectRatio="xMidYMid meet" transform="rotate(12 40 33)" />
      `;
    } else {
      const safeSymbol = symbol
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
      innerElements = `
        <text x="14" y="13" font-size="${size1}" transform="rotate(-14 14 13)">${safeSymbol}</text>
        <text x="40" y="33" font-size="${size2}" transform="rotate(12 40 33)">${safeSymbol}</text>
      `;
    }

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="52" height="44" viewBox="0 0 52 44">
      <defs>
        <filter id="t" x="-30%" y="-30%" width="160%" height="160%">
          <feFlood flood-color="${patternColor}" flood-opacity="0.4" result="c" />
          <feComposite in="c" in2="SourceAlpha" operator="in" />
        </filter>
      </defs>
      <g filter="url(#t)" font-family="Segoe UI Emoji, Apple Color Emoji, Noto Color Emoji, sans-serif" text-anchor="middle" dominant-baseline="central">
        ${innerElements}
      </g>
    </svg>`;

    const encoded = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
    return {
      backgroundColor: baseBg,
      borderColor: borderCol,
      backgroundImage: `url("${encoded}")`,
      backgroundRepeat: "repeat",
      backgroundSize: "52px 44px",
    };
  }

  return {
    backgroundColor: baseBg,
    borderColor: borderCol,
  };
}
