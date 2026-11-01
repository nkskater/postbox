import { describe, expect, it } from "vitest";
import {
  FIXED_SHORTCUTS,
  SHORTCUT_ACTIONS,
  actionForEvent,
  comboFromEvent,
  formatCombo,
  matchesCombo,
  normalizeCombo,
  parseOverrides,
  resolveBindings,
  serializeOverrides,
  validateCombo,
} from "@/lib/shortcuts";

const ev = (
  key: string,
  mods: Partial<{ ctrl: boolean; meta: boolean; alt: boolean; shift: boolean }> = {},
  code?: string,
) => ({
  key,
  code,
  ctrlKey: !!mods.ctrl,
  metaKey: !!mods.meta,
  altKey: !!mods.alt,
  shiftKey: !!mods.shift,
});
const defaults = () => resolveBindings({});

describe("combos", () => {
  it("normalises spellings", () => {
    expect(normalizeCombo("ctrl+shift+K")).toBe("Mod+Shift+k");
    expect(normalizeCombo("Cmd+,")).toBe("Mod+,");
    expect(normalizeCombo("option+t")).toBe("Alt+t");
    expect(normalizeCombo("shift+?")).toBe("?");
    expect(normalizeCombo("Mod++")).toBe("Mod++");
    expect(normalizeCombo("mod+enter")).toBe("Mod+Enter");
    expect(normalizeCombo("Mod+space")).toBe("Mod+Space");
    for (const bad of ["", "foo+k", "Mod", "Shift", "Mod+Alt+"]) expect(normalizeCombo(bad), bad).toBeNull();
  });

  it("keeps every default in canonical form, so it can match a real key event", () => {
    for (const a of SHORTCUT_ACTIONS) expect(normalizeCombo(a.default), a.id).toBe(a.default);
    expect(new Set(SHORTCUT_ACTIONS.map((a) => a.default)).size).toBe(SHORTCUT_ACTIONS.length);
  });

  it("reads key events, with Mod standing for Ctrl or ⌘", () => {
    expect(comboFromEvent(ev("Enter", { ctrl: true }))).toBe("Mod+Enter");
    expect(comboFromEvent(ev("S", { meta: true }))).toBe("Mod+s");
    expect(comboFromEvent(ev("K", { ctrl: true, shift: true }))).toBe("Mod+Shift+k");
    expect(comboFromEvent(ev("?", { shift: true }))).toBe("?");
    expect(comboFromEvent(ev(" ", { ctrl: true }))).toBe("Mod+Space");
    expect(comboFromEvent(ev("Shift", { shift: true }))).toBeNull();
    expect(comboFromEvent(ev("Control", { ctrl: true }))).toBeNull();
    // macOS reports a symbol for Alt+T; the physical key wins.
    expect(comboFromEvent(ev("†", { alt: true }, "KeyT"))).toBe("Alt+t");
    expect(comboFromEvent(ev("¡", { alt: true }, "Digit1"))).toBe("Alt+1");
  });

  it("matches modifiers exactly", () => {
    expect(matchesCombo(ev("s", { ctrl: true }), "Mod+s")).toBe(true);
    expect(matchesCombo(ev("s", { ctrl: true, shift: true }), "Mod+s")).toBe(false);
    expect(matchesCombo(ev("s", { ctrl: true, alt: true }), "Mod+s")).toBe(false);
    expect(matchesCombo(ev("s"), "Mod+s")).toBe(false);
  });

  it("formats for each platform", () => {
    expect(formatCombo("Mod+Shift+k", false)).toBe("Ctrl+Shift+K");
    expect(formatCombo("Mod+Shift+k", true)).toBe("⌘ ⇧ K");
    expect(formatCombo("Alt+t", false)).toBe("Alt+T");
    expect(formatCombo("Mod+Enter", false)).toBe("Ctrl+Enter");
    expect(formatCombo("Mod+,", false)).toBe("Ctrl+,");
    expect(formatCombo("?", false)).toBe("?");
    expect(formatCombo(null, false)).toBe("Not set");
  });
});

describe("bindings", () => {
  it("resolves defaults and overrides, ignoring unknown or malformed entries", () => {
    expect(defaults().send).toBe("Mod+Enter");
    const custom = resolveBindings(
      JSON.stringify({ send: "ctrl+shift+enter", save: null, nonsense: "Mod+x", palette: "garbage+" }),
    );
    expect(custom.send).toBe("Mod+Shift+Enter");
    expect(custom.save).toBeNull(); // explicitly unbound
    expect(custom.palette).toBe("Mod+k"); // malformed override falls back to the default
    for (const raw of ["not json", "[]", "null", 5, undefined, ""])
      expect(parseOverrides(raw), String(raw)).toEqual({});
  });

  it("stores only what differs from the defaults, and round-trips", () => {
    expect(serializeOverrides(defaults())).toBe("{}");
    const changed = { ...defaults(), send: "Mod+Shift+Enter", help: null };
    const text = serializeOverrides(changed);
    expect(JSON.parse(text)).toEqual({ send: "Mod+Shift+Enter", help: null });
    expect(resolveBindings(text)).toEqual(changed);
  });

  it("fires the action bound to an event, and rebinding moves it", () => {
    const b = defaults();
    expect(actionForEvent(ev("Enter", { ctrl: true }), b, false)).toBe("send");
    expect(actionForEvent(ev("t", { alt: true }, "KeyT"), b, false)).toBe("newRequest");
    const moved = { ...b, send: "Mod+Shift+Enter" };
    expect(actionForEvent(ev("Enter", { ctrl: true }), moved, false)).toBeNull();
    expect(actionForEvent(ev("Enter", { ctrl: true, shift: true }), moved, false)).toBe("send");
    expect(actionForEvent(ev("x"), b, false)).toBeNull();
  });

  it("does not fire bare keys while typing, but still fires modified ones", () => {
    const b = defaults();
    expect(actionForEvent(ev("?", { shift: true }), b, false)).toBe("help");
    expect(actionForEvent(ev("?", { shift: true }), b, true)).toBeNull();
    expect(actionForEvent(ev("k", { ctrl: true }), b, true)).toBe("palette");
  });
});

describe("conflict detection", () => {
  const b = defaults();

  it("accepts a free combination, including re-binding an action to its own current key", () => {
    expect(validateCombo("send", "Mod+Shift+Enter", b)).toEqual({ ok: true });
    expect(validateCombo("send", "Mod+Enter", b)).toEqual({ ok: true });
  });

  it("names the action that already uses a combination", () => {
    const r = validateCombo("send", "Mod+s", b);
    expect(r).toMatchObject({ ok: false, conflictWith: "save" });
    expect((r as { reason: string }).reason).toBe('Ctrl/⌘+S is already used for "Save request".');
    // Spelling does not matter.
    expect(validateCombo("send", "CTRL+S", b)).toMatchObject({ ok: false, conflictWith: "save" });
  });

  it("sees conflicts after other actions have been moved", () => {
    const moved = { ...b, save: "Mod+Shift+s" };
    expect(validateCombo("send", "Mod+s", moved)).toEqual({ ok: true });
    expect(validateCombo("send", "Mod+Shift+s", moved)).toMatchObject({ ok: false, conflictWith: "save" });
    expect(validateCombo("send", "Mod+k", { ...b, palette: null })).toEqual({ ok: true });
  });

  it("protects built-in shortcuts and the browser's", () => {
    expect(validateCombo("send", "Mod+f", b)).toMatchObject({ ok: false });
    expect(validateCombo("send", "Mod+Space", b)).toMatchObject({ ok: false });
    for (const n of [1, 5, 9])
      expect(validateCombo("send", `Alt+${n}`, b), `Alt+${n}`).toMatchObject({ ok: false });
    for (const r of ["Mod+t", "Mod+w", "Mod+n", "Mod+Tab", "F5"])
      expect(validateCombo("send", r, b), r).toMatchObject({ ok: false });
    expect(FIXED_SHORTCUTS.length).toBeGreaterThan(0);
  });

  it("requires a modifier except for the help shortcut and function keys", () => {
    expect(validateCombo("send", "x", b)).toMatchObject({ ok: false });
    expect(validateCombo("save", "Shift+s", b)).toMatchObject({ ok: false });
    expect(validateCombo("help", "h", b)).toEqual({ ok: true });
    expect(validateCombo("palette", "F2", b)).toEqual({ ok: true });
    expect(validateCombo("send", "garbage+", b)).toMatchObject({ ok: false });
  });
});
