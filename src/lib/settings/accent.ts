/**
 * Accent color presets and derivation of the primary/foreground/ring tokens
 * for each theme, with automatic readable button text.
 */
import { contrast, css, hexToOklch, type Oklch } from "@/lib/color";

export interface AccentPreset {
  id: string;
  label: string;
  /** Hue and chroma; lightness is chosen per theme. */
  h: number;
  c: number;
}

export const ACCENT_PRESETS: AccentPreset[] = [
  { id: "apricot", label: "Apricot", h: 58, c: 0.105 },
  { id: "orange", label: "Orange", h: 50, c: 0.15 },
  { id: "amber", label: "Amber", h: 75, c: 0.14 },
  { id: "yellow", label: "Yellow", h: 95, c: 0.14 },
  { id: "lime", label: "Lime", h: 128, c: 0.16 },
  { id: "green", label: "Green", h: 148, c: 0.14 },
  { id: "emerald", label: "Emerald", h: 163, c: 0.12 },
  { id: "teal", label: "Teal", h: 185, c: 0.1 },
  { id: "cyan", label: "Cyan", h: 210, c: 0.11 },
  { id: "sky", label: "Sky", h: 235, c: 0.11 },
  { id: "blue", label: "Blue", h: 258, c: 0.13 },
  { id: "indigo", label: "Indigo", h: 275, c: 0.13 },
  { id: "violet", label: "Violet", h: 293, c: 0.14 },
  { id: "purple", label: "Purple", h: 305, c: 0.15 },
  { id: "fuchsia", label: "Fuchsia", h: 322, c: 0.16 },
  { id: "pink", label: "Pink", h: 350, c: 0.13 },
  { id: "rose", label: "Rose", h: 12, c: 0.14 },
  { id: "red", label: "Red", h: 25, c: 0.16 },
  { id: "slate", label: "Slate", h: 255, c: 0.03 },
];

export const DEFAULT_ACCENT = "apricot";

export interface AccentTokens {
  primary: Oklch;
  foreground: Oklch;
  /** Contrast of button text on the accent (WCAG). */
  textContrast: number;
  /** Contrast of the accent against the page background (links, focus). */
  backgroundContrast: number;
}

const BACKGROUND: Record<"dark" | "light", Oklch> = {
  dark: { l: 0.17, c: 0.005, h: 270 },
  light: { l: 0.99, c: 0, h: 0 },
};

/** Accept a preset id or a #rrggbb custom color. */
export function isValidAccent(value: string): boolean {
  return ACCENT_PRESETS.some((p) => p.id === value) || !!hexToOklch(value);
}

export function accentTokens(value: string, theme: "dark" | "light"): AccentTokens {
  const preset = ACCENT_PRESETS.find((p) => p.id === value) ?? (hexToOklch(value) ? null : ACCENT_PRESETS[0]);
  let primary: Oklch;
  if (preset) {
    primary =
      theme === "dark" ? { l: 0.76, c: preset.c, h: preset.h } : { l: 0.6, c: preset.c * 1.05, h: preset.h };
  } else {
    // Custom colors are used as picked, but darkened in the light theme if they would be too pale.
    const picked = hexToOklch(value)!;
    primary =
      theme === "light"
        ? { ...picked, l: Math.min(picked.l, 0.62) }
        : { ...picked, l: Math.max(picked.l, 0.45) };
  }
  const white: Oklch = { l: 0.99, c: 0, h: 0 };
  const darkText = (p: Oklch): Oklch => ({ l: 0.22, c: Math.min(p.c, 0.04), h: p.h });
  const pick = (p: Oklch) => (contrast(p, darkText(p)) >= contrast(p, white) ? darkText(p) : white);
  let foreground = pick(primary);
  // Presets nudge their lightness until button text reaches WCAG AA (4.5:1).
  // Custom colors are kept exactly as picked; the UI shows a warning instead.
  for (let i = 0; preset && contrast(primary, foreground) < 4.5 && i < 20; i++) {
    primary = { ...primary, l: primary.l + (foreground === white ? -0.01 : 0.01) };
    foreground = pick(primary);
  }
  return {
    primary,
    foreground,
    textContrast: contrast(primary, foreground),
    backgroundContrast: contrast(primary, BACKGROUND[theme]),
  };
}

export function accentCssVars(value: string, theme: "dark" | "light"): Record<string, string> {
  const t = accentTokens(value, theme);
  return {
    "--primary": css(t.primary),
    "--primary-foreground": css(t.foreground),
    "--ring": css(t.primary, theme === "dark" ? 55 : 45),
  };
}
