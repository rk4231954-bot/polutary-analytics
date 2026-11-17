/** Locale-aware formatting helpers. Null/undefined/NaN render as an em dash. */
const DASH = "—";
const LOCALE = undefined; // use the browser locale

const isMissing = (v) => v === null || v === undefined || (typeof v === "number" && Number.isNaN(v));

export function formatNumber(value, { decimals = 0, compact = false } = {}) {
  if (isMissing(value)) return DASH;
  return new Intl.NumberFormat(LOCALE, {
    minimumFractionDigits: compact ? 0 : decimals,
    maximumFractionDigits: decimals,
    notation: compact ? "compact" : "standard",
  }).format(value);
}

export function formatPercent(value, decimals = 1) {
  if (isMissing(value)) return DASH;
  return `${formatNumber(value, { decimals })}%`;
}

export function formatWeightKg(grams, decimals = 2) {
  if (isMissing(grams)) return DASH;
  return formatNumber(grams / 1000, { decimals });
}

export function toDate(value) {
  if (value instanceof Date) return value;
  if (isMissing(value) || value === "") return null;
  // Treat bare YYYY-MM-DD as a local calendar date (not UTC midnight).
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split("-").map(Number);
    return new Date(y, m - 1, d);
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDate(value, options = { day: "numeric", month: "short", year: "numeric" }) {
  const date = toDate(value);
  return date ? new Intl.DateTimeFormat(LOCALE, options).format(date) : DASH;
}

export function formatShortDate(value) {
  return formatDate(value, { day: "numeric", month: "short" });
}

export function formatDateTime(value) {
  return formatDate(value, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function formatRelative(value, now = new Date()) {
  const date = toDate(value);
  if (!date) return DASH;
  const seconds = Math.round((date.getTime() - now.getTime()) / 1000);
  const units = [
    ["year", 31536000],
    ["month", 2592000],
    ["week", 604800],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  const rtf = new Intl.RelativeTimeFormat(LOCALE, { numeric: "auto" });
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
  }
  return rtf.format(seconds, "second");
}

export function formatBytes(bytes) {
  if (isMissing(bytes)) return DASH;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${formatNumber(value, { decimals: i === 0 ? 0 : 1 })} ${units[i]}`;
}

export function formatDuration(ms) {
  if (isMissing(ms)) return DASH;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60000) return `${formatNumber(ms / 1000, { decimals: 2 })} s`;
  return `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`;
}

/** YYYY-MM-DD in local time. */
export function toIsoDate(value) {
  const date = toDate(value);
  if (!date) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function initials(name) {
  if (!name) return "?";
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?";
}

export function titleCase(value) {
  return String(value ?? "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
