/** Custom colors for HTTP methods and status codes, as CSS variables (applied with the rest of the appearance). */

export const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
export type MethodName = (typeof METHODS)[number];

/** The built-in method colors (Tailwind's 400 shades). */
export const DEFAULT_METHOD_COLORS: Record<MethodName, string> = {
  GET: "#34d399",
  POST: "#fbbf24",
  PUT: "#38bdf8",
  PATCH: "#a78bfa",
  DELETE: "#fb7185",
  HEAD: "#2dd4bf",
  OPTIONS: "#f472b6",
};

export const STATUS_KEYS = ["ok", "redirect", "error"] as const;
export type StatusKey = (typeof STATUS_KEYS)[number];
export const STATUS_LABELS: Record<StatusKey, string> = {
  ok: "Success (2xx)",
  redirect: "Redirect (3xx)",
  error: "Error (4xx, 5xx, failed)",
};
/** Shown in the picker when nothing is customised; the real default follows the theme. */
export const STATUS_PICKER_DEFAULTS: Record<StatusKey, string> = {
  ok: "#4ade80",
  redirect: "#facc15",
  error: "#f87171",
};
const STATUS_THEME_DEFAULT: Record<StatusKey, string> = {
  ok: "var(--success)",
  redirect: "var(--warning)",
  error: "var(--destructive)",
};

/** A #rgb or #rrggbb color as lowercase #rrggbb, or null. */
export function normalizeHex(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (!m) return null;
  const hex = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  return `#${hex.toLowerCase()}`;
}

/** Parse stored overrides, keeping only known keys with valid colors. */
export function parseColors<K extends string>(raw: unknown, keys: readonly K[]): Partial<Record<K, string>> {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Partial<Record<K, string>> = {};
  for (const key of keys) {
    const hex = normalizeHex((value as Record<string, unknown>)[key]);
    if (hex) out[key] = hex;
  }
  return out;
}

/** Store only the colors that differ from the defaults. */
export function serializeColors<K extends string>(colors: Partial<Record<K, string>>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(colors).filter(([, v]) => v)));
}

/** Every color variable, always set, so removing a customisation restores the default. */
export function colorVars(methodRaw: unknown, statusRaw: unknown): Record<string, string> {
  const methods = parseColors(methodRaw, METHODS);
  const status = parseColors(statusRaw, STATUS_KEYS);
  const vars: Record<string, string> = {};
  for (const m of METHODS) vars[`--method-${m.toLowerCase()}`] = methods[m] ?? DEFAULT_METHOD_COLORS[m];
  for (const k of STATUS_KEYS) vars[`--status-${k}`] = status[k] ?? STATUS_THEME_DEFAULT[k];
  return vars;
}
