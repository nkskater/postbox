import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CORE_API_AREAS,
  CORE_TOOLSETS,
  CORE_VIEWS,
  FEATURES,
  featureOfPath,
  featureOfTool,
  featureOfView,
  type FeatureDef,
} from "@/core/features";
import { MCP_TOOLSETS } from "@/lib/mcp-toolsets";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-features-"));
process.env.DATABASE_PATH = path.join(dir, "test.db");

let repo: typeof import("@/server/repo");
let settings: typeof import("@/server/settings");
let mocks: typeof import("@/server/mocks");
let features: typeof import("@/server/features");
let policies: typeof import("@/server/access-policy");
let toolsets: typeof import("@/server/mcp-toolsets");
let mcpRoute: typeof import("@/app/api/mcp/route");
let mockRoutes: typeof import("@/app/api/mocks/route");
let mockServe: typeof import("@/app/mock/[id]/[[...path]]/route");
let telemetryRoutes: typeof import("@/app/api/telemetry/sources/route");
let workspaceId: string;
let folderId: string;

beforeAll(async () => {
  repo = await import("@/server/repo");
  settings = await import("@/server/settings");
  mocks = await import("@/server/mocks");
  features = await import("@/server/features");
  policies = await import("@/server/access-policy");
  toolsets = await import("@/server/mcp-toolsets");
  mcpRoute = await import("@/app/api/mcp/route");
  mockRoutes = await import("@/app/api/mocks/route");
  mockServe = await import("@/app/mock/[id]/[[...path]]/route");
  telemetryRoutes = await import("@/app/api/telemetry/sources/route");
  const ws = repo.createWorkspace("Features");
  workspaceId = ws.id;
  const folder = repo.createFolder(ws.id, null, { name: "Collection" });
  folderId = folder.id;
  repo.createRequest(ws.id, folder.id, {
    name: "Hello",
    url: "https://example.test/hello",
    examples: [
      { id: "ok", name: "OK", status: 200, statusText: "OK", headers: [], body: "hello", createdAt: 1 },
    ],
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  settings.patchSettings({ "features.mocks": null, "features.telemetry": null });
});
afterAll(async () => {
  (await import("@/server/db")).getSqlite().close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function rpc(method: string, params: object = {}) {
  const response = await mcpRoute.POST(
    new Request("http://localhost/api/mcp?toolsets=all", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
  );
  return JSON.parse(await response.text());
}
const toolNames = async () =>
  ((await rpc("tools/list")).result.tools as { name: string }[]).map((t) => t.name);
const get = (url: string) => new Request(`http://localhost${url}`);

describe("feature manifest coverage", () => {
  it("assigns every REST area to core or exactly one feature", () => {
    const areas = fs.readdirSync(path.join(process.cwd(), "src/app/api"));
    const unassigned: string[] = [];
    for (const area of areas) {
      const feature = featureOfPath(`/api/${area}`);
      const core = (CORE_API_AREAS as readonly string[]).includes(area);
      if (feature && core) throw new Error(`/api/${area} is both core and part of ${feature}`);
      if (!feature && !core) unassigned.push(area);
    }
    expect(unassigned, "add these to CORE_API_AREAS or a feature in src/core/features.ts").toEqual([]);
  });

  it("assigns every sidebar view to core or a feature", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src/components/sidebar/Sidebar.tsx"), "utf8");
    const block = source.slice(source.indexOf("const VIEWS = ["), source.indexOf("] as const;"));
    const views = [...block.matchAll(/id: "([^"]+)"/g)].map((m) => m[1]);
    expect(views.length).toBeGreaterThan(5);
    const unassigned = views.filter(
      (v) => !featureOfView(v) && !(CORE_VIEWS as readonly string[]).includes(v),
    );
    expect(unassigned, "add these views to CORE_VIEWS or a feature").toEqual([]);
  });

  it("assigns every MCP toolset to core or a feature, so every tool is classified", () => {
    const featured = new Set((FEATURES as readonly FeatureDef[]).flatMap((f) => f.toolsets ?? []));
    const unassigned = MCP_TOOLSETS.filter(
      (t) => !featured.has(t) && !(CORE_TOOLSETS as readonly string[]).includes(t),
    );
    expect(unassigned, "add these toolsets to CORE_TOOLSETS or a feature").toEqual([]);
    // Every tool has a toolset (toolsetOf throws otherwise), so every tool resolves to core or a feature.
    for (const name of Object.keys(policies.MCP_POLICIES)) featureOfTool(name, toolsets.toolsetOf(name));
    expect(featureOfTool("create_mock", "mocks")).toBe("mocks");
    expect(featureOfTool("list_vault_secrets", "vault-broker")).toBeNull();
    expect(featureOfTool("broker_call", "vault-broker")).toBe("broker");
  });

  it("matches nested area routes under core resources", () => {
    expect(featureOfPath("/api/folders/abc/comments")).toBe("collaboration");
    expect(featureOfPath("/api/folders/abc/releases")).toBe("releases");
    expect(featureOfPath("/api/folders/abc/specification")).toBe("specifications");
    expect(featureOfPath("/api/folders/abc")).toBeNull();
    expect(featureOfPath("/api/folders/abc/duplicate")).toBeNull();
    expect(featureOfPath("/api/mocksmith")).toBeNull();
    expect(featureOfPath("/mock/abc/users")).toBe("mocks");
  });

  it("gives every feature a setting that is on by default and can be pinned", () => {
    const values = settings.getSettings({} as NodeJS.ProcessEnv).values;
    for (const f of FEATURES) expect(values[`features.${f.id}`], f.id).toBe(true);
    expect(features.disabledFeatures({ POSTBOX_FEATURE_MOCKS: "false" })).toEqual(new Set(["mocks"]));
    expect(features.disabledFeatures({ POSTBOX_FEATURE_MCP_CLIENT: "0" })).toEqual(new Set(["mcp-client"]));
  });
});

describe("switching Mocks off and on", () => {
  it("hides routes, the public endpoint and MCP tools, and keeps the data", async () => {
    const mock = mocks.createMock({ workspaceId, folderId, name: "Hello mock", public: true });
    const served = await mockServe.GET(get(`/mock/${mock.id}/hello`), {
      params: Promise.resolve({ id: mock.id, path: ["hello"] }),
    });
    expect(served.status).toBe(200);
    expect(await toolNames()).toContain("create_mock");

    settings.patchSettings({ "features.mocks": false });

    const list = await mockRoutes.GET(get(`/api/mocks?workspaceId=${workspaceId}`));
    expect(list.status).toBe(404);
    expect((await list.json()).error).toMatch(/Mock servers is switched off/);
    const offServe = await mockServe.GET(get(`/mock/${mock.id}/hello`), {
      params: Promise.resolve({ id: mock.id, path: ["hello"] }),
    });
    expect(offServe.status).toBe(404);
    const names = await toolNames();
    expect(names).not.toContain("create_mock");
    expect(names).toContain("send_request");
    const call = await rpc("tools/call", { name: "list_mocks", arguments: { workspaceId } });
    expect(call.result.isError).toBe(true);
    expect(call.result.content[0].text).toMatch(/switched off/);
    // Other areas are unaffected.
    expect((await telemetryRoutes.GET(get(`/api/telemetry/sources?workspaceId=${workspaceId}`))).status).toBe(
      200,
    );

    settings.patchSettings({ "features.mocks": true });

    const back = await mockRoutes.GET(get(`/api/mocks?workspaceId=${workspaceId}`));
    expect(back.status).toBe(200);
    expect((await back.json()).map((m: { id: string }) => m.id)).toContain(mock.id);
    expect(await toolNames()).toContain("create_mock");
  });

  it("honours an environment pin over the saved switch", async () => {
    vi.stubEnv("POSTBOX_FEATURE_MOCKS", "false");
    settings.patchSettings({ "features.mocks": true });
    expect((await mockRoutes.GET(get(`/api/mocks?workspaceId=${workspaceId}`))).status).toBe(404);
    expect(settings.getSettings().envLocked["features.mocks"]).toBe("POSTBOX_FEATURE_MOCKS");
  });
});

describe("switching Telemetry off and on", () => {
  it("hides routes and tools, stops the retention worker, and keeps the data", async () => {
    const workers = await import("@/server/feature-workers");
    const timer = globalThis as typeof globalThis & { __postboxTelemetryRetention?: NodeJS.Timeout };
    // Only telemetry is under test; keep the other workers from starting timers.
    vi.stubEnv("POSTBOX_FEATURE_WORKFLOWS", "false");
    vi.stubEnv("POSTBOX_FEATURE_WEBHOOKS", "false");
    vi.stubEnv("POSTBOX_FEATURE_MONITORS", "false");

    const created = await telemetryRoutes.POST(
      new Request("http://localhost/api/telemetry/sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId, config: { name: "Prod", serviceName: "checkout" } }),
      }),
    );
    expect(created.status).toBe(201);

    settings.patchSettings({ "features.telemetry": false });
    if (timer.__postboxTelemetryRetention) clearInterval(timer.__postboxTelemetryRetention);
    delete timer.__postboxTelemetryRetention;
    await workers.startFeatureWorkers();
    expect(timer.__postboxTelemetryRetention).toBeUndefined();
    expect((await telemetryRoutes.GET(get(`/api/telemetry/sources?workspaceId=${workspaceId}`))).status).toBe(
      404,
    );
    expect(await toolNames()).not.toContain("list_telemetry_sources");

    settings.patchSettings({ "features.telemetry": true });
    await workers.startFeatureWorkers();
    expect(timer.__postboxTelemetryRetention).toBeDefined();
    clearInterval(timer.__postboxTelemetryRetention);
    delete timer.__postboxTelemetryRetention;
    const back = await telemetryRoutes.GET(get(`/api/telemetry/sources?workspaceId=${workspaceId}`));
    expect(back.status).toBe(200);
    expect((await back.json()).map((s: { config: { name: string } }) => s.config.name)).toEqual(["Prod"]);
    expect(await toolNames()).toContain("list_telemetry_sources");
  });
});
