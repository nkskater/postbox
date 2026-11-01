/**
 * Locale-aware formatting for times, dates and sizes, driven by explicit options so it can be
 * tested without a browser. `format.ts` wraps these with the user's current settings.
 */
export type TimeFormat = "system" | "12h" | "24h";
export type DateFormat = "system" | "iso" | "mdy" | "dmy";
export type ByteUnits = "kb" | "kib" | "si";

export interface LocaleOptions {
  timeFormat: TimeFormat;
  dateFormat: DateFormat;
  byteUnits: ByteUnits;
  /** "5m ago" style for recent times; false shows the full date and time. */
  relativeTimes: boolean;
}

export const DEFAULT_LOCALE: LocaleOptions = {
  timeFormat: "system",
  dateFormat: "system",
  byteUnits: "kb",
  relativeTimes: true,
};

const pad = (n: number) => String(n).padStart(2, "0");

export function formatTimeWith(ts: number, o: LocaleOptions): string {
  const d = new Date(ts);
  if (o.timeFormat === "system") return d.toLocaleTimeString();
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    ...(o.timeFormat === "12h" ? { hour12: true } : { hourCycle: "h23" as const }),
  }).format(d);
}

export function formatDateWith(ts: number, o: LocaleOptions): string {
  const d = new Date(ts);
  const [y, m, day] = [d.getFullYear(), pad(d.getMonth() + 1), pad(d.getDate())];
  switch (o.dateFormat) {
    case "iso":
      return `${y}-${m}-${day}`;
    case "mdy":
      return `${m}/${day}/${y}`;
    case "dmy":
      return `${day}/${m}/${y}`;
    default:
      return d.toLocaleDateString();
  }
}

export function formatDateTimeWith(ts: number, o: LocaleOptions): string {
  if (o.dateFormat === "system" && o.timeFormat === "system") return new Date(ts).toLocaleString();
  return `${formatDateWith(ts, o)} ${formatTimeWith(ts, o)}`;
}

const BYTE_UNITS: Record<ByteUnits, { base: number; labels: string[] }> = {
  kb: { base: 1024, labels: ["B", "KB", "MB", "GB", "TB"] },
  kib: { base: 1024, labels: ["B", "KiB", "MiB", "GiB", "TiB"] },
  si: { base: 1000, labels: ["B", "kB", "MB", "GB", "TB"] },
};

export function formatBytesWith(n: number | null | undefined, o: LocaleOptions): string {
  if (n == null) return "—";
  const { base, labels } = BYTE_UNITS[o.byteUnits];
  if (n < base) return `${n} B`;
  let value = n;
  let i = 0;
  while (value >= base && i < labels.length - 1) {
    value /= base;
    i++;
  }
  return `${value.toFixed(2)} ${labels[i]}`;
}

export function relativeTimeWith(ts: number, o: LocaleOptions, now = Date.now()): string {
  if (!o.relativeTimes) return formatDateTimeWith(ts, o);
  const diff = now - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return formatDateWith(ts, o);
}
