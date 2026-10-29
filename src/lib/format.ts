/**
 * Formatting helpers shared by editors and the response viewer.
 */

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

export function formatBytes(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(2)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function formatMs(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n < 1000) return `${Math.round(n)} ms`;
  return `${(n / 1000).toFixed(2)} s`;
}

export function statusColor(status: number | null | undefined): string {
  if (!status) return "text-destructive";
  if (status < 300) return "text-success";
  if (status < 400) return "text-warning";
  return "text-destructive";
}

export const METHOD_COLORS: Record<string, string> = {
  GET: "text-emerald-400",
  POST: "text-amber-400",
  PUT: "text-sky-400",
  PATCH: "text-violet-400",
  DELETE: "text-rose-400",
  HEAD: "text-teal-400",
  OPTIONS: "text-pink-400",
};

export const methodColor = (m: string) => METHOD_COLORS[m.toUpperCase()] ?? "text-muted-foreground";

export function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(ts).toLocaleDateString();
}
