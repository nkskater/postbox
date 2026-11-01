/**
 * Formatting helpers shared by editors and the response viewer.
 */
import { getSetting } from "@/lib/settings/runtime";
import {
  DEFAULT_LOCALE,
  formatBytesWith,
  formatDateTimeWith,
  formatDateWith,
  formatTimeWith,
  relativeTimeWith,
  type LocaleOptions,
} from "@/lib/locale";

/** Pretty-print XML with two-space indentation (best effort, no validation). */
export function formatXml(xml: string): string {
  const tokens = xml
    .replace(/>\s+</g, "><")
    .replace(/(>)(<)(\/*)/g, "$1\n$2$3")
    .split("\n");
  let depth = 0;
  return tokens
    .map((line) => {
      const t = line.trim();
      if (/^<\/\w/.test(t)) depth = Math.max(0, depth - 1);
      const out = "  ".repeat(depth) + t;
      if (/^<\w[^>]*[^/]>.*$/.test(t) && !/<\/\w[^>]*>$/.test(t) && !/^<\?/.test(t) && !/^<!/.test(t))
        depth++;
      return out;
    })
    .join("\n");
}

/** The user's locale settings right now (time/date format, size units, relative times). */
export function currentLocale(): LocaleOptions {
  const pick = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
    const value = getSetting<string>(key);
    return (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
  };
  return {
    timeFormat: pick("locale.timeFormat", ["system", "12h", "24h"], DEFAULT_LOCALE.timeFormat),
    dateFormat: pick("locale.dateFormat", ["system", "iso", "mdy", "dmy"], DEFAULT_LOCALE.dateFormat),
    byteUnits: pick("locale.byteUnits", ["kb", "kib", "si"], DEFAULT_LOCALE.byteUnits),
    relativeTimes: getSetting<string>("locale.timeStyle") !== "absolute",
  };
}

export const formatBytes = (n: number | null | undefined) => formatBytesWith(n, currentLocale());
export const formatTime = (ts: number) => formatTimeWith(ts, currentLocale());
export const formatDate = (ts: number) => formatDateWith(ts, currentLocale());
export const formatDateTime = (ts: number) => formatDateTimeWith(ts, currentLocale());

export function formatMs(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n < 1000) return `${Math.round(n)} ms`;
  return `${(n / 1000).toFixed(2)} s`;
}

export function statusColor(status: number | null | undefined): string {
  if (!status) return "text-status-error";
  if (status < 300) return "text-status-ok";
  if (status < 400) return "text-status-redirect";
  return "text-status-error";
}

/** Literal class names, so Tailwind finds them; the colors come from CSS variables the user can change. */
export const METHOD_COLORS: Record<string, string> = {
  GET: "text-method-get",
  POST: "text-method-post",
  PUT: "text-method-put",
  PATCH: "text-method-patch",
  DELETE: "text-method-delete",
  HEAD: "text-method-head",
  OPTIONS: "text-method-options",
};

export const methodColor = (m: string) => METHOD_COLORS[m.toUpperCase()] ?? "text-muted-foreground";

export const relativeTime = (ts: number) => relativeTimeWith(ts, currentLocale());
