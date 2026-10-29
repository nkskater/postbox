/**
 * App settings registry: the single source of truth for every user-facing setting.
 * The Settings page is generated from it, the server validates against it, and
 * consumers read values by key. Shared by browser and server (no Node imports).
 *
 * To add a setting: add an entry here, then read it where it is used.
 */
import { isValidAccent, DEFAULT_ACCENT } from "./accent";

export type SettingCategory = "appearance" | "layout";

export const CATEGORIES: { id: SettingCategory; label: string; description: string }[] = [
  { id: "appearance", label: "Appearance", description: "Theme, colors, typography and density." },
  { id: "layout", label: "Layout", description: "Where panels live and how they are arranged." },
];

interface Base<T> {
  key: string;
  category: SettingCategory;
  label: string;
  description: string;
  default: T;
  /** browser: applied in the UI; server: read by the server (may be pinned by an env var). */
  scope: "browser" | "server";
  /** Environment variable that overrides the saved value (server settings). */
  env?: string;
  keywords?: string[];
}

export type SettingDef =
  | (Base<string> & { type: "select"; options: { value: string; label: string }[] })
  | (Base<boolean> & { type: "boolean" })
  | (Base<number> & { type: "number"; min: number; max: number; step?: number; unit?: string })
  | (Base<string> & { type: "accent" });

export type SettingValue = string | number | boolean;

export const SETTINGS: SettingDef[] = [
  {
    key: "appearance.theme",
    category: "appearance",
    label: "Theme",
    description: "Dark, light, or follow your operating system.",
    type: "select",
    scope: "browser",
    default: "dark",
    options: [
      { value: "dark", label: "Dark" },
      { value: "light", label: "Light" },
      { value: "system", label: "System" },
    ],
    keywords: ["dark mode", "light mode", "color scheme"],
  },
  {
    key: "appearance.accent",
    category: "appearance",
    label: "Accent color",
    description:
      "Used for primary buttons, the active tab, links and focus rings. Pick a preset or any custom color.",
    type: "accent",
    scope: "browser",
    default: DEFAULT_ACCENT,
    keywords: ["primary", "brand", "orange", "color", "colour", "highlight"],
  },
  {
    key: "appearance.tone",
    category: "appearance",
    label: "Background tone",
    description: "The tint of backgrounds, borders and muted text.",
    type: "select",
    scope: "browser",
    default: "zinc",
    options: [
      { value: "neutral", label: "Neutral" },
      { value: "zinc", label: "Zinc" },
      { value: "slate", label: "Slate" },
      { value: "ocean", label: "Ocean" },
      { value: "stone", label: "Stone" },
      { value: "warm", label: "Warm" },
    ],
    keywords: ["palette", "gray", "grey", "background", "tint"],
  },
  {
    key: "appearance.oled",
    category: "appearance",
    label: "True black (OLED)",
    description: "Use pure black backgrounds in the dark theme.",
    type: "boolean",
    scope: "browser",
    default: false,
    keywords: ["amoled", "black", "dark"],
  },
  {
    key: "appearance.fontSize",
    category: "appearance",
    label: "Interface font size",
    description: "Scales all text and controls in the interface.",
    type: "number",
    scope: "browser",
    default: 14,
    min: 12,
    max: 18,
    step: 1,
    unit: "px",
    keywords: ["zoom", "scale", "text size"],
  },
  {
    key: "appearance.fontFamily",
    category: "appearance",
    label: "Interface font",
    description:
      "Font used for the interface. Fonts must be installed on this computer; otherwise the system font is used.",
    type: "select",
    scope: "browser",
    default: "system",
    options: [
      { value: "system", label: "System default" },
      { value: "inter", label: "Inter" },
      { value: "plex", label: "IBM Plex Sans" },
      { value: "segoe", label: "Segoe UI" },
      { value: "roboto", label: "Roboto" },
      { value: "ubuntu", label: "Ubuntu" },
      { value: "mono", label: "Monospace" },
    ],
    keywords: ["typeface", "typography"],
  },
  {
    key: "appearance.density",
    category: "appearance",
    label: "Density",
    description: "Spacing between and inside controls.",
    type: "select",
    scope: "browser",
    default: "comfortable",
    options: [
      { value: "compact", label: "Compact" },
      { value: "comfortable", label: "Comfortable" },
      { value: "spacious", label: "Spacious" },
    ],
    keywords: ["spacing", "padding", "compact"],
  },
  {
    key: "appearance.radius",
    category: "appearance",
    label: "Corner radius",
    description: "Roundness of buttons, inputs and panels.",
    type: "select",
    scope: "browser",
    default: "default",
    options: [
      { value: "sharp", label: "Sharp" },
      { value: "default", label: "Default" },
      { value: "round", label: "Round" },
    ],
    keywords: ["rounded", "corners", "border radius"],
  },
  {
    key: "appearance.reduceMotion",
    category: "appearance",
    label: "Reduce motion",
    description: "Turn off animations and transitions.",
    type: "boolean",
    scope: "browser",
    default: false,
    keywords: ["animation", "accessibility"],
  },
  {
    key: "layout.sidebarPosition",
    category: "layout",
    label: "Sidebar position",
    description: "Show the collections sidebar on the left or the right.",
    type: "select",
    scope: "browser",
    default: "left",
    options: [
      { value: "left", label: "Left" },
      { value: "right", label: "Right" },
    ],
    keywords: ["panel", "side"],
  },
  {
    key: "layout.sidebarLabels",
    category: "layout",
    label: "Sidebar rail labels",
    description: "Show text labels under the sidebar icons.",
    type: "boolean",
    scope: "browser",
    default: true,
    keywords: ["icons", "rail"],
  },
  {
    key: "layout.requestLayout",
    category: "layout",
    label: "Request & response layout",
    description: "Stack the response below the request, or place them side by side.",
    type: "select",
    scope: "browser",
    default: "stacked",
    options: [
      { value: "stacked", label: "Stacked" },
      { value: "side-by-side", label: "Side by side" },
    ],
    keywords: ["split", "horizontal", "vertical", "pane"],
  },
];

export const SETTINGS_BY_KEY = new Map(SETTINGS.map((s) => [s.key, s]));

export function defaultValues(defs: SettingDef[] = SETTINGS): Record<string, SettingValue> {
  return Object.fromEntries(defs.map((d) => [d.key, d.default]));
}

/** Returns the validated value or throws with a readable message. */
export function validateSetting(def: SettingDef, value: unknown): SettingValue {
  switch (def.type) {
    case "boolean":
      if (typeof value !== "boolean") throw new Error(`${def.label} must be true or false`);
      return value;
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value))
        throw new Error(`${def.label} must be a number`);
      if (value < def.min || value > def.max)
        throw new Error(`${def.label} must be between ${def.min} and ${def.max}`);
      return value;
    }
    case "select":
      if (typeof value !== "string" || !def.options.some((o) => o.value === value))
        throw new Error(`${def.label} must be one of: ${def.options.map((o) => o.value).join(", ")}`);
      return value;
    case "accent":
      if (typeof value !== "string" || !isValidAccent(value))
        throw new Error(`${def.label} must be a preset name or a #rrggbb color`);
      return value.startsWith("#") ? value.toLowerCase() : value;
  }
}

/** Effective values with precedence: environment variable > saved value > default. */
export function resolveSettings(
  saved: Record<string, unknown>,
  env: Record<string, string | undefined> = {},
  defs: SettingDef[] = SETTINGS,
): { values: Record<string, SettingValue>; envLocked: Record<string, string> } {
  const values: Record<string, SettingValue> = {};
  const envLocked: Record<string, string> = {};
  for (const def of defs) {
    let value: SettingValue = def.default;
    if (def.key in saved) {
      try {
        value = validateSetting(def, saved[def.key]);
      } catch {
        /* ignore stale/invalid saved values */
      }
    }
    const raw = def.env ? env[def.env] : undefined;
    if (raw !== undefined && raw !== "") {
      try {
        const parsed =
          def.type === "number" ? Number(raw) : def.type === "boolean" ? /^(1|true|yes|on)$/i.test(raw) : raw;
        value = validateSetting(def, parsed);
        envLocked[def.key] = def.env!;
      } catch {
        /* invalid env values fall back to the saved value */
      }
    }
    values[def.key] = value;
  }
  return { values, envLocked };
}

/** Keep only known keys with valid values (used for PATCH and import). Unknown keys are reported. */
export function sanitizeSettings(input: Record<string, unknown>): {
  valid: Record<string, SettingValue | null>;
  errors: string[];
} {
  const valid: Record<string, SettingValue | null> = {};
  const errors: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    const def = SETTINGS_BY_KEY.get(key);
    if (!def) {
      errors.push(`Unknown setting "${key}"`);
      continue;
    }
    if (value === null) {
      valid[key] = null;
      continue;
    }
    try {
      valid[key] = validateSetting(def, value);
    } catch (err) {
      errors.push((err as Error).message);
    }
  }
  return { valid, errors };
}

/** Search across labels, descriptions, keywords and option labels. */
export function matchesQuery(def: SettingDef, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = [
    def.label,
    def.description,
    def.key,
    ...(def.keywords ?? []),
    ...(def.type === "select" ? def.options.map((o) => o.label) : []),
  ]
    .join(" ")
    .toLowerCase();
  return q.split(/\s+/).every((word) => hay.includes(word));
}
