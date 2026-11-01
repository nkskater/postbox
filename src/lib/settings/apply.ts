/**
 * Turns appearance/layout settings into CSS variables, classes and data attributes
 * on <html>. The computed result is cached in localStorage so the pre-paint script
 * in the root layout can apply it before React hydrates (no flash of the default theme).
 */
import { accentCssVars } from "./accent";
import { colorVars } from "@/lib/colors";
import type { SettingValue } from "./registry";

export const APPEARANCE_CACHE_KEY = "postbox-appearance";

export interface ComputedAppearance {
  theme: "dark" | "light";
  vars: Record<string, string>;
  attrs: string[];
  fontFamily: string;
}

const TONES: Record<string, [number, number]> = {
  neutral: [0, 0],
  zinc: [270, 0.005],
  slate: [255, 0.012],
  ocean: [240, 0.02],
  stone: [60, 0.006],
  warm: [50, 0.012],
};

const FONTS: Record<string, string> = {
  system: "",
  inter: '"Inter", "Inter Variable", ui-sans-serif, system-ui, sans-serif',
  plex: '"IBM Plex Sans", ui-sans-serif, system-ui, sans-serif',
  segoe: '"Segoe UI", ui-sans-serif, system-ui, sans-serif',
  roboto: "Roboto, ui-sans-serif, system-ui, sans-serif",
  ubuntu: "Ubuntu, ui-sans-serif, system-ui, sans-serif",
  mono: 'ui-monospace, "JetBrains Mono", "Cascadia Code", Menlo, Consolas, monospace',
};

const MONO_FALLBACK =
  'ui-monospace, "JetBrains Mono", "Cascadia Code", "SFMono-Regular", Menlo, Consolas, monospace';
const CODE_FONTS: Record<string, string> = {
  default: MONO_FALLBACK,
  jetbrains: `"JetBrains Mono", ${MONO_FALLBACK}`,
  fira: `"Fira Code", ${MONO_FALLBACK}`,
  cascadia: `"Cascadia Code", "Cascadia Mono", ${MONO_FALLBACK}`,
  source: `"Source Code Pro", ${MONO_FALLBACK}`,
  ibm: `"IBM Plex Mono", ${MONO_FALLBACK}`,
  consolas: `Consolas, ${MONO_FALLBACK}`,
  menlo: `Menlo, Monaco, ${MONO_FALLBACK}`,
};

const DENSITY: Record<string, string> = { compact: "0.22rem", comfortable: "0.25rem", spacious: "0.285rem" };
const RADIUS: Record<string, string> = { sharp: "0.15rem", default: "0.5rem", round: "0.85rem" };

export function resolveTheme(setting: SettingValue | undefined): "dark" | "light" {
  if (setting === "light" || setting === "dark") return setting;
  if (typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: light)").matches)
    return "light";
  return "dark";
}

export function computeAppearance(values: Record<string, SettingValue>): ComputedAppearance {
  const theme = resolveTheme(values["appearance.theme"]);
  const [h, c] = TONES[String(values["appearance.tone"])] ?? TONES.zinc;
  const fontSize = Number(values["appearance.fontSize"]) || 14;
  const vars: Record<string, string> = {
    "--tone-h": String(h),
    "--tone-c": String(c),
    "--radius": RADIUS[String(values["appearance.radius"])] ?? RADIUS.default,
    "--spacing": DENSITY[String(values["appearance.density"])] ?? DENSITY.comfortable,
    // The interface is designed around 14px body text on a 16px root; scale the root.
    "font-size": `${((fontSize / 14) * 100).toFixed(2)}%`,
    "--code-font-size": `${Number(values["editor.fontSize"]) || 12.5}px`,
    "--code-line-height": String(Number(values["editor.lineHeight"]) || 1.4),
    "--code-font": CODE_FONTS[String(values["editor.fontFamily"])] ?? CODE_FONTS.default,
    ...accentCssVars(String(values["appearance.accent"] ?? "apricot"), theme),
    ...colorVars(values["appearance.methodColors"], values["appearance.statusColors"]),
  };
  const attrs: string[] = [];
  if (values["appearance.oled"]) attrs.push("data-oled");
  if (values["appearance.reduceMotion"]) attrs.push("data-reduce-motion");
  return { theme, vars, attrs, fontFamily: FONTS[String(values["appearance.fontFamily"])] ?? "" };
}

const MANAGED_ATTRS = ["data-oled", "data-reduce-motion"];

export function applyAppearance(computed: ComputedAppearance) {
  const root = document.documentElement;
  root.classList.toggle("light", computed.theme === "light");
  for (const [k, v] of Object.entries(computed.vars)) root.style.setProperty(k, v);
  for (const a of MANAGED_ATTRS) root.toggleAttribute(a, computed.attrs.includes(a));
  root.style.fontFamily = computed.fontFamily;
  try {
    localStorage.setItem(APPEARANCE_CACHE_KEY, JSON.stringify(computed));
  } catch {
    /* storage may be unavailable (private mode) */
  }
}

/**
 * Inline script for <head>: re-applies the cached computed appearance before first paint.
 * Kept dependency-free and tiny; it only replays what applyAppearance() stored.
 */
export const PREPAINT_SCRIPT = `(function(){try{var a=JSON.parse(localStorage.getItem(${JSON.stringify(
  APPEARANCE_CACHE_KEY,
)})||"null");if(!a)return;var r=document.documentElement;r.classList.toggle("light",a.theme==="light");for(var k in a.vars)r.style.setProperty(k,a.vars[k]);(a.attrs||[]).forEach(function(x){r.setAttribute(x,"")});if(a.fontFamily)r.style.fontFamily=a.fontFamily}catch(e){}})();`;
