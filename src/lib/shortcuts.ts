/**
 * Keyboard shortcut registry: the actions that can be bound, their defaults, matching of key
 * events, display text, and validation with conflict detection. Pure: no DOM or React.
 *
 * A combo is written like "Mod+Shift+K", "Alt+t" or "?". Mod is Ctrl or ⌘. Modifiers must match
 * exactly, so Ctrl+Shift+S does not trigger Ctrl+S.
 */

export type ShortcutId =
  "send" | "save" | "palette" | "settings" | "console" | "sidebar" | "newRequest" | "closeTab" | "help";

export interface ShortcutAction {
  id: ShortcutId;
  label: string;
  default: string;
  /** May be a bare key with no modifier (ignored while typing in a field). */
  allowBare?: boolean;
}

export const SHORTCUT_ACTIONS: ShortcutAction[] = [
  { id: "send", label: "Send request", default: "Mod+Enter" },
  { id: "save", label: "Save request", default: "Mod+s" },
  { id: "palette", label: "Command palette", default: "Mod+k" },
  { id: "settings", label: "Open settings", default: "Mod+," },
  { id: "console", label: "Toggle console", default: "Mod+`" },
  { id: "sidebar", label: "Toggle sidebar", default: "Mod+b" },
  { id: "newRequest", label: "New request tab", default: "Alt+t" },
  { id: "closeTab", label: "Close tab", default: "Alt+w" },
  { id: "help", label: "Show keyboard shortcuts", default: "?", allowBare: true },
];

/** Shortcuts handled elsewhere (the editors, the tab bar). Shown, but not rebindable. */
export const FIXED_SHORTCUTS: { combo: string; label: string; matches: (combo: string) => boolean }[] = [
  { combo: "Alt+1…9", label: "Jump to tab", matches: (c) => /^Alt\+[1-9]$/.test(c) },
  { combo: "Mod+F", label: "Search inside an editor or response", matches: (c) => c === "Mod+f" },
  { combo: "Mod+Space", label: "Variable autocomplete (after typing {{)", matches: (c) => c === "Mod+Space" },
];

/** Combos the browser or operating system keeps for itself. */
const RESERVED = new Set([
  "Mod+t",
  "Mod+w",
  "Mod+n",
  "Mod+r",
  "Mod+l",
  "Mod+q",
  "Mod+Tab",
  "F5",
  "F11",
  "F12",
]);

const MODIFIER_NAMES = new Set(["mod", "ctrl", "cmd", "meta", "control", "alt", "option", "shift"]);
/** Keys with a name rather than a single character. */
const NAMED_KEYS = new Set([
  "Enter",
  "Tab",
  "Space",
  "Escape",
  "Backspace",
  "Delete",
  "Insert",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
]);

const MODIFIER_ORDER = ["Mod", "Alt", "Shift"] as const;
const MODIFIER_KEYS = new Set(["Control", "Meta", "Alt", "Shift", "AltGraph", "OS"]);

const LABELS: Record<string, string> = {
  " ": "Space",
  Escape: "Esc",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
};

/** Canonical key name: single characters lowercase, named keys as the browser spells them. */
function canonicalKey(key: string): string {
  if (key === " " || key.toLowerCase() === "space") return "Space";
  if (key.length === 1) return key.toLowerCase();
  const named = key.charAt(0).toUpperCase() + key.slice(1);
  return named;
}

/** Normalise a combo string; returns null when it is malformed. */
export function normalizeCombo(input: string): string | null {
  const parts = input.split(/\+(?!$)/).map((p) => p.trim());
  const keyPart = parts.pop();
  if (!keyPart) return null;
  const mods = new Set<string>();
  for (const part of parts) {
    const m = part.toLowerCase();
    if (m === "mod" || m === "ctrl" || m === "cmd" || m === "meta" || m === "control") mods.add("Mod");
    else if (m === "alt" || m === "option") mods.add("Alt");
    else if (m === "shift") mods.add("Shift");
    else return null;
  }
  const key = canonicalKey(keyPart);
  if (MODIFIER_KEYS.has(key) || MODIFIER_NAMES.has(key.toLowerCase())) return null;
  if (key.length > 1 && !NAMED_KEYS.has(key)) return null;
  const ordered = MODIFIER_ORDER.filter((m) => mods.has(m));
  // A symbol such as "?" already includes Shift on most keyboards, so Shift is not part of its combo.
  const symbol = key.length === 1 && !/[a-z0-9]/.test(key);
  return [...ordered.filter((m) => !(m === "Shift" && symbol)), key.length === 1 ? key : key].join("+");
}

interface KeyEventLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** The key of an event; with Alt held, macOS reports a symbol, so the physical key is used. */
function eventKey(e: KeyEventLike): string {
  if (e.altKey && e.code) {
    const letter = /^Key([A-Z])$/.exec(e.code);
    if (letter) return letter[1].toLowerCase();
    const digit = /^Digit([0-9])$/.exec(e.code);
    if (digit) return digit[1];
  }
  return canonicalKey(e.key);
}

/** The combo for a key event, or null for a lone modifier press. */
export function comboFromEvent(e: KeyEventLike): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null;
  const key = eventKey(e);
  const mods: string[] = [];
  if (e.ctrlKey || e.metaKey) mods.push("Mod");
  if (e.altKey) mods.push("Alt");
  const symbol = key.length === 1 && !/[a-z0-9]/.test(key);
  if (e.shiftKey && !symbol) mods.push("Shift");
  return [...mods, key].join("+");
}

export function matchesCombo(e: KeyEventLike, combo: string): boolean {
  return comboFromEvent(e) === combo;
}

export type Bindings = Record<ShortcutId, string | null>;
type Overrides = Partial<Record<ShortcutId, string | null>>;

/** Parse the stored overrides, ignoring anything unknown or malformed. */
export function parseOverrides(raw: unknown): Overrides {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Overrides = {};
  for (const action of SHORTCUT_ACTIONS) {
    const entry = (value as Record<string, unknown>)[action.id];
    if (entry === null)
      out[action.id] = null; // explicitly unbound
    else if (typeof entry === "string") {
      const combo = normalizeCombo(entry);
      if (combo) out[action.id] = combo;
    }
  }
  return out;
}

/** The binding of every action: the override when present, otherwise the default. */
export function resolveBindings(raw: unknown): Bindings {
  const overrides = parseOverrides(raw);
  return Object.fromEntries(
    SHORTCUT_ACTIONS.map((a) => [a.id, a.id in overrides ? (overrides[a.id] ?? null) : a.default]),
  ) as Bindings;
}

/** Store only what differs from the defaults. */
export function serializeOverrides(bindings: Bindings): string {
  const overrides: Overrides = {};
  for (const action of SHORTCUT_ACTIONS)
    if (bindings[action.id] !== action.default) overrides[action.id] = bindings[action.id];
  return JSON.stringify(overrides);
}

/** The action a key event triggers, or null. Bare keys never fire while typing in a field. */
export function actionForEvent(e: KeyEventLike, bindings: Bindings, typing: boolean): ShortcutId | null {
  const combo = comboFromEvent(e);
  if (!combo) return null;
  for (const action of SHORTCUT_ACTIONS) {
    if (bindings[action.id] !== combo) continue;
    if (!/(Mod|Alt)\+/.test(combo) && typing) continue;
    return action.id;
  }
  return null;
}

export type ComboCheck = { ok: true } | { ok: false; reason: string; conflictWith?: ShortcutId };

/** Whether `combo` may be bound to `id`, given everything else that is bound. */
/** Platform-neutral text for messages: Ctrl/⌘+S. */
const readable = (combo: string) => formatCombo(combo, false).replace("Ctrl", "Ctrl/⌘");

export function validateCombo(id: ShortcutId, input: string, bindings: Bindings): ComboCheck {
  const combo = normalizeCombo(input);
  if (!combo) return { ok: false, reason: "That is not a valid key combination." };
  const action = SHORTCUT_ACTIONS.find((a) => a.id === id)!;
  const hasModifier = /^(Mod|Alt)\+/.test(combo) || /\+(Mod|Alt)\+/.test(combo);
  if (!hasModifier && !action.allowBare && !/^F([1-9]|1[0-2])$/.test(combo))
    return {
      ok: false,
      reason: "Use Ctrl/⌘ or Alt with a key (only the help shortcut can be a single key).",
    };
  if (RESERVED.has(combo)) return { ok: false, reason: `${readable(combo)} is reserved by the browser.` };
  const fixed = FIXED_SHORTCUTS.find((f) => f.matches(combo));
  if (fixed) return { ok: false, reason: `${readable(combo)} is already used for "${fixed.label}".` };
  for (const other of SHORTCUT_ACTIONS) {
    if (other.id !== id && bindings[other.id] === combo)
      return {
        ok: false,
        reason: `${readable(combo)} is already used for "${other.label}".`,
        conflictWith: other.id,
      };
  }
  return { ok: true };
}

/** Text for a combo: ⌘ and ⌥ on macOS, Ctrl and Alt elsewhere. */
export function formatCombo(combo: string | null, mac: boolean): string {
  if (!combo) return "Not set";
  return combo
    .split(/\+(?!$)/)
    .map((part) => {
      if (part === "Mod") return mac ? "⌘" : "Ctrl";
      if (part === "Alt") return mac ? "⌥" : "Alt";
      if (part === "Shift") return mac ? "⇧" : "Shift";
      if (part.length === 1) return part.toUpperCase();
      return LABELS[part] ?? part;
    })
    .join(mac ? " " : "+");
}

export const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
