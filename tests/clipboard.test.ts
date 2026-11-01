import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "@/lib/clipboard";

interface FakeArea {
  value: string;
  removed: boolean;
  selected: boolean;
  attrs: Record<string, string>;
  style: { cssText: string };
  setAttribute(k: string, v: string): void;
  focus(): void;
  select(): void;
  setSelectionRange(a: number, b: number): void;
  remove(): void;
}

/** A tiny DOM: just enough for the textarea fallback. */
function setup(opts: { clipboard?: unknown; secure: boolean; exec?: () => boolean; dialog?: boolean }) {
  const areas: FakeArea[] = [];
  const appended: { host: string; area: FakeArea }[] = [];
  const focused: string[] = [];
  const dialog = { name: "dialog", appendChild: (a: FakeArea) => appended.push({ host: "dialog", area: a }) };
  const body = { name: "body", appendChild: (a: FakeArea) => appended.push({ host: "body", area: a }) };
  const trigger = {
    focus: () => focused.push("trigger"),
    closest: (sel: string) => (opts.dialog && sel === '[role="dialog"]' ? dialog : null),
  };
  vi.stubGlobal("window", { isSecureContext: opts.secure });
  vi.stubGlobal("navigator", { clipboard: opts.clipboard });
  vi.stubGlobal("document", {
    body,
    activeElement: trigger,
    createElement: () => {
      const area: FakeArea = {
        value: "",
        removed: false,
        selected: false,
        attrs: {},
        style: { cssText: "" },
        setAttribute(k, v) {
          this.attrs[k] = v;
        },
        focus: () => focused.push("area"),
        select() {
          this.selected = true;
        },
        setSelectionRange: () => undefined,
        remove() {
          this.removed = true;
        },
      };
      areas.push(area);
      return area;
    },
    execCommand: vi.fn((cmd: string) => (cmd === "copy" ? (opts.exec ? opts.exec() : true) : false)),
  });
  return { areas, appended, focused };
}

afterEach(() => vi.unstubAllGlobals());

describe("copyText", () => {
  it("uses the async clipboard in a secure context", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const env = setup({ clipboard: { writeText }, secure: true });
    expect(await copyText("secret-token")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("secret-token");
    expect(env.areas).toHaveLength(0);
  });

  it("falls back to a textarea when navigator.clipboard is missing (plain HTTP)", async () => {
    const env = setup({ clipboard: undefined, secure: false });
    expect(await copyText("pbx_abc123")).toBe(true);
    expect(env.areas).toHaveLength(1);
    const [area] = env.areas;
    expect(area.value).toBe("pbx_abc123");
    expect(area.selected).toBe(true);
    expect(document.execCommand as ReturnType<typeof vi.fn>).toHaveBeenCalledWith("copy");
    // Cleans up and returns focus to the button that was clicked.
    expect(area.removed).toBe(true);
    expect(env.focused).toEqual(["area", "trigger"]);
    expect(env.appended[0].host).toBe("body");
  });

  it("does not use the async clipboard on an insecure page even if it exists", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("blocked"));
    setup({ clipboard: { writeText }, secure: false });
    expect(await copyText("x")).toBe(true);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("falls back when the async clipboard rejects", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("NotAllowedError"));
    const env = setup({ clipboard: { writeText }, secure: true });
    expect(await copyText("x")).toBe(true);
    expect(env.areas).toHaveLength(1);
  });

  it("puts the textarea inside an open dialog so its focus trap does not interfere", async () => {
    const env = setup({ clipboard: undefined, secure: false, dialog: true });
    await copyText("x");
    expect(env.appended[0].host).toBe("dialog");
  });

  it("reports failure when the browser refuses to copy", async () => {
    const env = setup({ clipboard: undefined, secure: false, exec: () => false });
    expect(await copyText("x")).toBe(false);
    expect(env.areas[0].removed).toBe(true);
    setup({
      clipboard: undefined,
      secure: false,
      exec: () => {
        throw new Error("denied");
      },
    });
    expect(await copyText("x")).toBe(false);
  });
});
