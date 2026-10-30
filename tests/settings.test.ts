import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SETTINGS,
  defaultValues,
  matchesQuery,
  resolveSettings,
  sanitizeSettings,
  validateSetting,
  type SettingDef,
} from "@/lib/settings/registry";
import { ACCENT_PRESETS, accentTokens, isValidAccent } from "@/lib/settings/accent";
import { computeAppearance } from "@/lib/settings/apply";
import { contrast, hexToOklch, oklchToHex } from "@/lib/color";

// Throwaway database for the API tests.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-settings-"));
process.env.DATABASE_PATH = path.join(dir, "settings.db");

describe("settings registry", () => {
  it("has unique keys and valid defaults", () => {
    const keys = SETTINGS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const def of SETTINGS) expect(validateSetting(def, def.default)).toEqual(def.default);
  });

  it("rejects invalid values", () => {
    const get = (k: string) => SETTINGS.find((s) => s.key === k)!;
    expect(() => validateSetting(get("appearance.theme"), "purple")).toThrow(/one of/);
    expect(() => validateSetting(get("appearance.fontSize"), 40)).toThrow(/between 12 and 18/);
    expect(() => validateSetting(get("appearance.oled"), "yes")).toThrow(/true or false/);
    expect(() => validateSetting(get("appearance.accent"), "#12345")).toThrow(/preset/);
    expect(validateSetting(get("appearance.accent"), "#AABBCC")).toBe("#aabbcc");
  });

  it("sanitizes patches, keeps null resets and reports unknown keys", () => {
    const { valid, errors } = sanitizeSettings({
      "appearance.theme": "light",
      "appearance.radius": null,
      "appearance.fontSize": 99,
      "nope.unknown": 1,
    });
    expect(valid).toEqual({ "appearance.theme": "light", "appearance.radius": null });
    expect(errors).toHaveLength(2);
  });

  it("applies precedence env > saved > default and ignores invalid saved values", () => {
    const defs: SettingDef[] = [
      {
        key: "x.limit",
        category: "layout",
        label: "Limit",
        description: "",
        scope: "server",
        type: "number",
        default: 10,
        min: 1,
        max: 100,
        env: "X_LIMIT",
      },
      {
        key: "x.flag",
        category: "layout",
        label: "Flag",
        description: "",
        scope: "server",
        type: "boolean",
        default: false,
        env: "X_FLAG",
      },
      {
        key: "x.mode",
        category: "layout",
        label: "Mode",
        description: "",
        scope: "browser",
        type: "select",
        default: "a",
        options: [
          { value: "a", label: "A" },
          { value: "b", label: "B" },
        ],
      },
    ];
    expect(resolveSettings({}, {}, defs).values).toEqual({ "x.limit": 10, "x.flag": false, "x.mode": "a" });
    expect(resolveSettings({ "x.limit": 20, "x.mode": "zzz" }, {}, defs).values).toEqual({
      "x.limit": 20,
      "x.flag": false,
      "x.mode": "a",
    });
    const r = resolveSettings({ "x.limit": 20 }, { X_LIMIT: "50", X_FLAG: "true" }, defs);
    expect(r.values).toMatchObject({ "x.limit": 50, "x.flag": true });
    expect(r.envLocked).toEqual({ "x.limit": "X_LIMIT", "x.flag": "X_FLAG" });
    // Numeric env pins outside the range are clamped; non-numeric ones are ignored.
    const high = resolveSettings({ "x.limit": 20 }, { X_LIMIT: "5000" }, defs);
    expect(high.values["x.limit"]).toBe(100);
    expect(high.envLocked).toEqual({ "x.limit": "X_LIMIT" });
    const bad = resolveSettings({ "x.limit": 20 }, { X_LIMIT: "lots" }, defs);
    expect(bad.values["x.limit"]).toBe(20);
    expect(bad.envLocked).toEqual({});
  });

  it("searches labels, keywords and option labels", () => {
    const accent = SETTINGS.find((s) => s.key === "appearance.accent")!;
    expect(matchesQuery(accent, "orange")).toBe(true);
    expect(matchesQuery(accent, "ACCENT colour")).toBe(true);
    expect(
      matchesQuery(
        SETTINGS.find((s) => s.key === "appearance.tone")!,
        "stone",
      ),
    ).toBe(true);
    expect(matchesQuery(accent, "sidebar")).toBe(false);
  });
});

describe("accent colors", () => {
  it("round-trips hex through OKLCH", () => {
    for (const hex of ["#d4915e", "#3366ff", "#000000", "#ffffff", "#7f7f7f"]) {
      expect(oklchToHex(hexToOklch(hex)!)).toBe(hex);
    }
  });

  it("gives every preset readable button text in both themes", () => {
    for (const p of ACCENT_PRESETS) {
      for (const theme of ["dark", "light"] as const) {
        const t = accentTokens(p.id, theme);
        expect(t.textContrast, `${p.id} ${theme}`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(t.primary, t.foreground)).toBeCloseTo(t.textContrast);
      }
    }
  });

  it("accepts custom colors and picks dark or light text automatically", () => {
    expect(isValidAccent("#ffee00")).toBe(true);
    expect(isValidAccent("teal")).toBe(true);
    expect(isValidAccent("chartreuse")).toBe(false);
    expect(accentTokens("#ffee00", "dark").foreground.l).toBeLessThan(0.5);
    expect(accentTokens("#1a237e", "dark").foreground.l).toBeGreaterThan(0.9);
  });

  it("computes CSS variables and attributes from settings", () => {
    const c = computeAppearance({
      ...defaultValues(),
      "appearance.theme": "light",
      "appearance.accent": "blue",
      "appearance.tone": "neutral",
      "appearance.fontSize": 16,
      "appearance.oled": true,
      "appearance.reduceMotion": true,
      "appearance.density": "compact",
      "appearance.radius": "sharp",
    });
    expect(c.theme).toBe("light");
    expect(c.vars["--tone-c"]).toBe("0");
    expect(c.vars["--primary"]).toMatch(/^oklch\(0\.[56]\d\d 0\.137 258\.0\)$/);
    expect(c.vars["font-size"]).toBe("114.29%");
    expect(c.vars["--spacing"]).toBe("0.22rem");
    expect(c.vars["--radius"]).toBe("0.15rem");
    expect(c.attrs).toEqual(["data-oled", "data-reduce-motion"]);
  });
});

describe("settings API", () => {
  type Route = typeof import("@/app/api/settings/route");
  type ImportRoute = typeof import("@/app/api/settings/import/route");
  let api: Route;
  let importApi: ImportRoute;
  beforeAll(async () => {
    api = await import("@/app/api/settings/route");
    importApi = await import("@/app/api/settings/import/route");
  });
  const patch = (values: Record<string, unknown>) =>
    api.PATCH(
      new Request("http://x/api/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ values }),
      }),
    );

  it("persists, resets, exports and imports settings", async () => {
    let res = await api.GET();
    let body = await res.json();
    expect(body.values).toEqual(defaultValues());
    expect(body.environment.find((e: { name: string }) => e.name === "POSTBOX_PASSWORD").value).toMatch(
      /not set|configured/,
    );

    res = await patch({ "appearance.accent": "#3366FF", "appearance.theme": "light" });
    body = await res.json();
    expect(res.status).toBe(200);
    expect(body.values["appearance.accent"]).toBe("#3366ff");
    expect(body.saved).toEqual({ "appearance.accent": "#3366ff", "appearance.theme": "light" });

    expect((await patch({ "appearance.fontSize": 2 })).status).toBe(400);

    body = await (await patch({ "appearance.theme": null })).json();
    expect(body.saved).toEqual({ "appearance.accent": "#3366ff" });
    expect(body.values["appearance.theme"]).toBe("dark");

    const exported = await (await importApi.GET()).json();
    expect(exported).toMatchObject({ postboxSettings: 1, settings: { "appearance.accent": "#3366ff" } });

    await patch({ "appearance.radius": "round" });
    const imported = await (
      await importApi.POST(
        new Request("http://x/api/settings/import", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            settings: { ...exported.settings, "appearance.oled": true, "bogus.key": 1 },
          }),
        }),
      )
    ).json();
    // Import replaces everything: radius is gone, oled added, unknown keys reported.
    expect(imported.saved).toEqual({ "appearance.accent": "#3366ff", "appearance.oled": true });
    expect(imported.skipped).toEqual(['Unknown setting "bogus.key"']);
  });
});
