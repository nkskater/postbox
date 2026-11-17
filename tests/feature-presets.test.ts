import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  FEATURE_IDS,
  FEATURE_PRESETS,
  featureOfTool,
  featurePreset,
  featureSettingKey,
  matchingPreset,
  presetSwitches,
} from "@/core/features";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-presets-"));
process.env.DATABASE_PATH = path.join(dir, "test.db");

let settings: typeof import("@/server/settings");
let features: typeof import("@/server/features");
let toolsets: typeof import("@/server/mcp-toolsets");
let mcpRoute: typeof import("@/app/api/mcp/route");

beforeAll(async () => {
  settings = await import("@/server/settings");
  features = await import("@/server/features");
  toolsets = await import("@/server/mcp-toolsets");
  mcpRoute = await import("@/app/api/mcp/route");
});
afterEach(() => {
  vi.unstubAllEnvs();
  settings.patchSettings(Object.fromEntries(FEATURE_IDS.map((id) => [featureSettingKey(id), null])));
});
afterAll(async () => {
  (await import("@/server/db")).getSqlite().close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const minimal = featurePreset("minimal")!;
async function toolNames() {
  const response = await mcpRoute.POST(
    new Request("http://localhost/api/mcp?toolsets=all", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    }),
  );
  return ((await response.json()).result.tools as { name: string }[]).map((t) => t.name);
}

describe("feature presets", () => {
  it("defines presets over known areas, with Full matching the default", () => {
    for (const p of FEATURE_PRESETS) for (const id of p.features) expect(FEATURE_IDS).toContain(id);
    expect(matchingPreset(new Set(FEATURE_IDS))?.id).toBe("full");
    expect(matchingPreset(new Set())?.id).toBe("minimal");
    expect(matchingPreset(new Set(["mocks"]))).toBeUndefined();
    expect(featurePreset(" Minimal ")?.id).toBe("minimal");
    expect(featurePreset("nope")).toBeUndefined();
  });

  it("applying Minimal leaves only core routes and MCP tools, and shows Custom after a single change", async () => {
    settings.patchSettings(presetSwitches(minimal));
    expect(features.disabledFeatures({})).toEqual(new Set(FEATURE_IDS));

    const { route } = await import("@/server/http");
    const handler = route((_req: Request) => Response.json({ ok: true }));
    const status = async (url: string) => (await handler(new Request(`http://localhost${url}`))).status;
    expect(await status("/api/mocks")).toBe(404);
    expect(await status("/api/monitors")).toBe(404);
    expect(await status("/api/folders/f1/comments")).toBe(404);
    expect(await status("/mock/abc")).toBe(404);
    // The core API client keeps answering.
    for (const url of ["/api/workspaces", "/api/environments", "/api/vault", "/api/runs", "/api/schedules"])
      expect(await status(url), url).not.toBe(404);

    const names = await toolNames();
    const optional = names.filter((n) => featureOfTool(n, toolsets.toolsetOf(n)));
    expect(optional).toEqual([]);
    for (const core of [
      "send_request",
      "run_collection",
      "set_variables",
      "list_environments",
      "list_vault_secrets",
    ])
      expect(names).toContain(core);

    const enabled = () =>
      new Set(FEATURE_IDS.filter((id) => !features.disabledFeatures({}).has(id)) as string[]);
    expect(matchingPreset(enabled())?.id).toBe("minimal");
    settings.patchSettings({ "features.mocks": true });
    expect(matchingPreset(enabled())).toBeUndefined();
  });

  it("POSTBOX_FEATURE_PRESET sets the starting switches; saved choices and per-area variables win", () => {
    expect(features.disabledFeatures({ POSTBOX_FEATURE_PRESET: "minimal" })).toEqual(new Set(FEATURE_IDS));
    const team = features.disabledFeatures({ POSTBOX_FEATURE_PRESET: "team" });
    expect(team.has("mocks")).toBe(false);
    expect(team.has("telemetry")).toBe(true);
    // An individual variable overrides the preset.
    const pinned = features.disabledFeatures({
      POSTBOX_FEATURE_PRESET: "minimal",
      POSTBOX_FEATURE_MOCKS: "true",
    });
    expect(pinned.has("mocks")).toBe(false);
    // A switch saved in Settings overrides the preset.
    settings.patchSettings({ "features.telemetry": true });
    expect(features.disabledFeatures({ POSTBOX_FEATURE_PRESET: "minimal" }).has("telemetry")).toBe(false);
    // An unknown preset is ignored (everything stays on).
    expect(features.disabledFeatures({ POSTBOX_FEATURE_PRESET: "tiny" })).toEqual(new Set());
    vi.stubEnv("POSTBOX_FEATURE_PRESET", "minimal");
    expect(settings.getSettings().values["features.mocks"]).toBe(false);
    expect(settings.getSettings().environment.find((e) => e.name === "POSTBOX_FEATURE_PRESET")?.value).toBe(
      "minimal",
    );
  });
});
