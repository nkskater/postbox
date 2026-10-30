import { beforeEach, describe, expect, it } from "vitest";
import { defaultValues } from "@/lib/settings/registry";
import { setRuntimeSettings } from "@/lib/settings/runtime";
import { computeAppearance } from "@/lib/settings/apply";
import { defaultRequestSettings, isTabDirty, newDraft, snapshot, useApp, type Tab } from "@/stores/app";
import { useDialogs } from "@/stores/dialogs";

const withSettings = (overrides: Record<string, string | number | boolean>) =>
  setRuntimeSettings({ ...defaultValues(), ...overrides });

const requestTab = (id: string, patch: Partial<Extract<Tab, { type: "request" }>> = {}): Tab => {
  const draft = newDraft({ url: "http://x" });
  return { id, type: "request", requestId: id, draft, saved: snapshot(draft), ...patch };
};

beforeEach(() => {
  withSettings({});
  useApp.setState({ tabs: [], activeTabId: null, consoleEntries: [], consoleOpen: false });
  useDialogs.setState({ confirmCloseTabId: null });
});

describe("request defaults", () => {
  it("uses Requests settings for new drafts", () => {
    withSettings({
      "requests.defaultMethod": "POST",
      "requests.timeoutMs": 5000,
      "requests.verifySsl": false,
      "requests.followRedirects": false,
      "requests.maxRedirects": 3,
      "requests.useCookieJar": false,
    });
    const d = newDraft();
    expect(d.method).toBe("POST");
    expect(d.settings).toEqual({
      timeoutMs: 5000,
      verifySsl: false,
      followRedirects: false,
      maxRedirects: 3,
      useCookieJar: false,
    });
    expect(defaultRequestSettings()).toEqual(d.settings);
    // Explicit values still win.
    expect(newDraft({ method: "DELETE" }).method).toBe("DELETE");
  });
});

describe("tabs", () => {
  it("detects unsaved changes", () => {
    const saved = requestTab("a");
    expect(isTabDirty(saved)).toBe(false);
    if (saved.type !== "request") throw new Error();
    expect(isTabDirty({ ...saved, draft: { ...saved.draft, url: "http://changed" } })).toBe(true);
    expect(isTabDirty({ id: "n", type: "request", requestId: null, draft: newDraft(), saved: null })).toBe(
      false,
    );
    expect(
      isTabDirty({
        id: "n",
        type: "request",
        requestId: null,
        draft: newDraft({ url: "http://y" }),
        saved: null,
      }),
    ).toBe(true);
    expect(isTabDirty({ id: "g", type: "globals", name: "Globals" })).toBe(false);
  });

  it("asks before closing a dirty tab only when the setting is on", () => {
    const base = requestTab("a");
    if (base.type !== "request") throw new Error();
    const dirty: Tab = { ...base, draft: { ...base.draft, url: "http://changed" } };
    useApp.setState({ tabs: [dirty], activeTabId: "a" });
    useApp.getState().requestCloseTab("a");
    expect(useDialogs.getState().confirmCloseTabId).toBe("a");
    expect(useApp.getState().tabs).toHaveLength(1);

    withSettings({ "tabs.confirmCloseUnsaved": false });
    useApp.getState().requestCloseTab("a");
    expect(useApp.getState().tabs).toHaveLength(0);
  });

  it("closes the oldest clean tabs beyond the maximum, never dirty or active ones", () => {
    withSettings({ "tabs.maxOpen": 3 });
    const dirtyBase = requestTab("dirty");
    if (dirtyBase.type !== "request") throw new Error();
    const dirty: Tab = { ...dirtyBase, draft: { ...dirtyBase.draft, url: "http://changed" } };
    useApp.setState({ tabs: [dirty, requestTab("b"), requestTab("c")], activeTabId: "c" });
    useApp.setState((s) => ({ tabs: [...s.tabs, requestTab("d")], activeTabId: "d" }));
    expect(useApp.getState().tabs.map((t) => t.id)).toEqual(["dirty", "c", "d"]);

    withSettings({ "tabs.maxOpen": 0 });
    useApp.setState((s) => ({ tabs: [...s.tabs, requestTab("e"), requestTab("f")] }));
    expect(useApp.getState().tabs).toHaveLength(5);
  });
});

describe("console", () => {
  const entry = (level: "log" | "error", message: string) => ({
    level,
    message,
    source: "test",
    timestamp: 0,
  });

  it("caps entries and opens on errors when enabled", () => {
    withSettings({ "console.maxEntries": 100 });
    useApp.getState().log(Array.from({ length: 150 }, (_, i) => entry("log", String(i))));
    expect(useApp.getState().consoleEntries).toHaveLength(100);
    expect(useApp.getState().consoleEntries[0].message).toBe("50");
    useApp.getState().log([entry("error", "boom")]);
    expect(useApp.getState().consoleOpen).toBe(false);

    withSettings({ "console.openOnError": true });
    useApp.getState().log([entry("log", "fine")]);
    expect(useApp.getState().consoleOpen).toBe(false);
    useApp.getState().log([entry("error", "boom")]);
    expect(useApp.getState().consoleOpen).toBe(true);
  });
});

describe("editor appearance", () => {
  it("exposes code font settings as CSS variables", () => {
    const c = computeAppearance({
      ...defaultValues(),
      "editor.fontSize": 15,
      "editor.lineHeight": 1.8,
      "editor.fontFamily": "fira",
    });
    expect(c.vars["--code-font-size"]).toBe("15px");
    expect(c.vars["--code-line-height"]).toBe("1.8");
    expect(c.vars["--code-font"]).toMatch(/^"Fira Code", /);
  });
});
