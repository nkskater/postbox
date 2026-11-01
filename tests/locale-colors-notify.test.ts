import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOCALE,
  formatBytesWith,
  formatDateTimeWith,
  formatDateWith,
  formatTimeWith,
  relativeTimeWith,
  type LocaleOptions,
} from "@/lib/locale";
import {
  DEFAULT_METHOD_COLORS,
  METHODS,
  STATUS_KEYS,
  colorVars,
  normalizeHex,
  parseColors,
  serializeColors,
} from "@/lib/colors";
import { describeRun, shouldAnnounceRun, type RunFinished } from "@/lib/notify";
import { methodColor, statusColor } from "@/lib/format";
import { computeAppearance } from "@/lib/settings/apply";
import { defaultValues } from "@/lib/settings/registry";

const o = (patch: Partial<LocaleOptions> = {}): LocaleOptions => ({ ...DEFAULT_LOCALE, ...patch });
// Local components, so the tests hold in any time zone: 1 Nov 2026, 15:45:30 (and 09:05:07).
const afternoon = new Date(2026, 10, 1, 15, 45, 30).getTime();
const morning = new Date(2026, 10, 1, 9, 5, 7).getTime();

describe("times and dates", () => {
  it("uses a 12-hour or 24-hour clock on request", () => {
    expect(formatTimeWith(afternoon, o({ timeFormat: "24h" }))).toBe("15:45:30");
    expect(formatTimeWith(morning, o({ timeFormat: "24h" }))).toBe("09:05:07");
    expect(formatTimeWith(afternoon, o({ timeFormat: "12h" }))).toMatch(/^0?3:45:30\s?PM$/i);
    expect(formatTimeWith(morning, o({ timeFormat: "12h" }))).toMatch(/^0?9:05:07\s?AM$/i);
    // "system" is whatever the runtime's own formatting gives.
    expect(formatTimeWith(afternoon, o())).toBe(new Date(afternoon).toLocaleTimeString());
  });

  it("writes dates as ISO, month-first or day-first", () => {
    expect(formatDateWith(afternoon, o({ dateFormat: "iso" }))).toBe("2026-11-01");
    expect(formatDateWith(afternoon, o({ dateFormat: "mdy" }))).toBe("11/01/2026");
    expect(formatDateWith(afternoon, o({ dateFormat: "dmy" }))).toBe("01/11/2026");
    expect(formatDateWith(afternoon, o())).toBe(new Date(afternoon).toLocaleDateString());
  });

  it("combines date and time, keeping the runtime's own form when nothing is customised", () => {
    expect(formatDateTimeWith(afternoon, o())).toBe(new Date(afternoon).toLocaleString());
    expect(formatDateTimeWith(afternoon, o({ dateFormat: "iso", timeFormat: "24h" }))).toBe(
      "2026-11-01 15:45:30",
    );
    expect(formatDateTimeWith(afternoon, o({ dateFormat: "iso" }))).toBe(
      `2026-11-01 ${new Date(afternoon).toLocaleTimeString()}`,
    );
  });

  it("shows recent times relatively, or always in full", () => {
    const now = afternoon;
    expect(relativeTimeWith(now - 5_000, o(), now)).toBe("just now");
    expect(relativeTimeWith(now - 5 * 60_000, o(), now)).toBe("5m ago");
    expect(relativeTimeWith(now - 3 * 3_600_000, o(), now)).toBe("3h ago");
    expect(relativeTimeWith(now - 3 * 86_400_000, o({ dateFormat: "iso" }), now)).toBe("2026-10-29");
    expect(
      relativeTimeWith(
        now - 5 * 60_000,
        o({ relativeTimes: false, dateFormat: "iso", timeFormat: "24h" }),
        now,
      ),
    ).toBe("2026-11-01 15:40:30");
  });
});

describe("sizes", () => {
  it("keeps the historical output by default", () => {
    expect(formatBytesWith(null, o())).toBe("—");
    expect(formatBytesWith(512, o())).toBe("512 B");
    expect(formatBytesWith(2048, o())).toBe("2.00 KB");
    expect(formatBytesWith(5 * 1024 * 1024, o())).toBe("5.00 MB");
  });

  it("supports binary names and decimal units", () => {
    expect(formatBytesWith(2048, o({ byteUnits: "kib" }))).toBe("2.00 KiB");
    expect(formatBytesWith(3 * 1024 ** 3, o({ byteUnits: "kib" }))).toBe("3.00 GiB");
    expect(formatBytesWith(999, o({ byteUnits: "si" }))).toBe("999 B");
    expect(formatBytesWith(1000, o({ byteUnits: "si" }))).toBe("1.00 kB");
    expect(formatBytesWith(1_500_000, o({ byteUnits: "si" }))).toBe("1.50 MB");
    expect(formatBytesWith(1000, o())).toBe("1000 B"); // 1024 base: still under a kilobyte
  });
});

describe("custom colors", () => {
  it("normalises and validates hex colors", () => {
    expect(normalizeHex("#ABC")).toBe("#aabbcc");
    expect(normalizeHex(" #34D399 ")).toBe("#34d399");
    for (const bad of [
      "red",
      "#12",
      "#12345",
      "#gggggg",
      "34d399",
      5,
      null,
      "javascript:alert(1)",
      "#fff; background:red",
    ])
      expect(normalizeHex(bad), String(bad)).toBeNull();
  });

  it("parses stored overrides, ignoring unknown keys and bad values", () => {
    expect(parseColors('{"GET":"#fff","FOO":"#000","POST":"red"}', METHODS)).toEqual({ GET: "#ffffff" });
    for (const raw of ["not json", "[]", "null", 3, undefined, ""])
      expect(parseColors(raw, METHODS)).toEqual({});
    expect(JSON.parse(serializeColors({ GET: "#ffffff" }))).toEqual({ GET: "#ffffff" });
  });

  it("always sets every variable, so removing a customisation restores the default", () => {
    const plain = colorVars("{}", "{}");
    expect(Object.keys(plain)).toHaveLength(METHODS.length + STATUS_KEYS.length);
    expect(plain["--method-get"]).toBe(DEFAULT_METHOD_COLORS.GET);
    expect(plain["--status-ok"]).toBe("var(--success)");
    const custom = colorVars('{"GET":"#ff0000"}', '{"error":"#00ff00"}');
    expect(custom["--method-get"]).toBe("#ff0000");
    expect(custom["--method-post"]).toBe(DEFAULT_METHOD_COLORS.POST);
    expect(custom["--status-error"]).toBe("#00ff00");
    expect(custom["--status-ok"]).toBe("var(--success)");
  });

  it("flows into the computed appearance, which is cached for the next page load", () => {
    const values = { ...defaultValues(), "appearance.methodColors": '{"DELETE":"#123456"}' };
    expect(computeAppearance(values).vars["--method-delete"]).toBe("#123456");
    expect(computeAppearance(defaultValues()).vars["--method-delete"]).toBe(DEFAULT_METHOD_COLORS.DELETE);
  });

  it("styles methods and statuses through variable-backed classes", () => {
    expect(methodColor("get")).toBe("text-method-get");
    expect(methodColor("PATCH")).toBe("text-method-patch");
    expect(methodColor("PROPFIND")).toBe("text-muted-foreground");
    expect(statusColor(204)).toBe("text-status-ok");
    expect(statusColor(302)).toBe("text-status-redirect");
    expect(statusColor(404)).toBe("text-status-error");
    expect(statusColor(0)).toBe("text-status-error");
  });
});

describe("run notifications", () => {
  const run = (patch: Partial<RunFinished> = {}): RunFinished => ({
    name: "Nightly",
    status: "passed",
    durationMs: 45_000,
    totalRequests: 12,
    failedRequests: 0,
    ...patch,
  });
  const on = { enabled: true, thresholdSeconds: 30, sound: false };

  it("announces only long runs, when enabled, and only when nobody is watching", () => {
    expect(shouldAnnounceRun(run(), on, false)).toBe(true);
    expect(shouldAnnounceRun(run(), { ...on, enabled: false }, false)).toBe(false);
    expect(shouldAnnounceRun(run(), on, true)).toBe(false);
    expect(shouldAnnounceRun(run({ durationMs: 29_999 }), on, false)).toBe(false);
    expect(shouldAnnounceRun(run({ durationMs: 30_000 }), on, false)).toBe(true);
    expect(shouldAnnounceRun(run({ status: "cancelled" }), on, false)).toBe(false);
    expect(shouldAnnounceRun(run({ status: "failed", failedRequests: 3 }), on, false)).toBe(true);
  });

  it("describes the outcome", () => {
    expect(describeRun(run())).toEqual({ title: "Run passed: Nightly", body: "12 requests in 45 s" });
    expect(describeRun(run({ status: "failed", failedRequests: 2, durationMs: 62_400 }))).toEqual({
      title: "Run failed: Nightly",
      body: "12 requests in 62 s, 2 failed",
    });
    expect(describeRun(run({ status: "error" })).title).toBe("Run stopped with an error: Nightly");
  });
});
