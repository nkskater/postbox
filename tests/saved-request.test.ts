import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execute } from "@/core/executor";
import { DEFAULT_SETTINGS, type RequestDef } from "@/core/types";
import { emptyScopes } from "@/core/variables/resolver";
import { HostPolicy } from "@/core/http/policy";
import { startTestServer, type TestServer } from "./helpers/server";
import {
  helperPreScript,
  helperTestScript,
  conformancePreScript,
  conformanceTestScript,
} from "./helpers/sandbox-conformance";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-saved-request-"));
process.env.DATABASE_PATH = path.join(dir, "test.db");
let server: TestServer;
let repo: typeof import("@/server/repo");
let context: typeof import("@/server/context");
let db: typeof import("@/server/db");
beforeAll(async () => {
  server = await startTestServer();
  repo = await import("@/server/repo");
  context = await import("@/server/context");
  db = await import("@/server/db");
});
afterAll(async () => {
  await server.close();
  db.getSqlite().close();
  fs.rmSync(dir, { recursive: true, force: true });
});
const request = (overrides: Partial<RequestDef> = {}): RequestDef => ({
  id: "root",
  name: "Root",
  url: `${server.url}/echo`,
  method: "GET",
  params: [],
  headers: [],
  body: { mode: "none" },
  auth: { type: "none" },
  preRequestScript: "",
  testScript: "",
  settings: { ...DEFAULT_SETTINGS },
  ...overrides,
});

describe("saved request execution", () => {
  it("passes the shared conformance fixture through the UI Send route", async () => {
    const ws = repo.createWorkspace("Conformance");
    const folder = repo.createFolder(ws.id, null, { name: "Conformance" });
    const environment = repo.createEnvironment(ws.id, "Environment");
    repo.persistScopeDiff(ws.id, "collection", folder.id, {}, { base: server.url, value: "root" });
    const helper = repo.createRequest(ws.id, folder.id, {
      name: "Helper",
      url: "{{base}}/echo?value={{value}}",
      preRequestScript: helperPreScript,
      testScript: helperTestScript,
    });
    repo.persistScopeDiff(ws.id, "global", null, {}, { helperId: helper.id });
    const { POST } = await import("@/app/api/proxy/route");
    const response = await POST(
      new Request("http://localhost/api/proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: ws.id,
          folderId: folder.id,
          environmentId: environment.id,
          request: request({ preRequestScript: conformancePreScript, testScript: conformanceTestScript }),
        }),
      }),
    );
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.scriptErrors).toEqual([]);
    expect(result.tests).toHaveLength(9);
    expect(result.tests.every((test: { passed: boolean }) => test.passed)).toBe(true);
    expect(result.nextRequestSet).toBe(false);
    expect(repo.listVariables(ws.id, "environment", environment.id)).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: "childResult", value: "yes" })]),
    );
  });

  it("hides missing and foreign request IDs equally without sending them", async () => {
    const own = repo.createWorkspace("Own");
    const foreign = repo.createWorkspace("Foreign");
    const folder = repo.createFolder(foreign.id, null);
    const target = repo.createRequest(foreign.id, folder.id, { url: `${server.url}/echo?foreign=yes` });
    const before = server.requests.length;
    for (const id of [target.id, "missing"]) {
      const result = await context.runSingleRequest({
        workspaceId: own.id,
        environmentId: null,
        folderId: null,
        saveHistory: false,
        request: request({ preRequestScript: `await pm.execution.runRequest(${JSON.stringify(id)});` }),
      });
      expect(result.scriptErrors[0].message).toMatch(/Request not found/);
    }
    expect(server.requests.slice(before).some((r) => r.url.includes("foreign"))).toBe(false);
  });

  it("isolates referenced collection variables, persists its changes and redacts its secrets", async () => {
    const ws = repo.createWorkspace("Cross collection");
    const root = repo.createFolder(ws.id, null);
    const target = repo.createFolder(ws.id, null);
    const env = repo.createEnvironment(ws.id, "Environment");
    repo.persistScopeDiff(ws.id, "collection", root.id, {}, { source: "root", fallback: "root-only" });
    repo.persistScopeDiff(
      ws.id,
      "collection",
      target.id,
      {},
      { source: "target", secret: "child-secret-value" },
    );
    repo.replaceVariables(
      ws.id,
      "collection",
      target.id,
      repo
        .listVariables(ws.id, "collection", target.id)
        .map((v) => ({ ...v, type: v.key === "secret" ? "secret" : "default" })),
    );
    const child = repo.createRequest(ws.id, target.id, {
      url: `${server.url}/echo?source={{source}}&fallback={{fallback}}`,
      testScript: `pm.test("precedence", () => pm.expect(pm.response.json().query).to.deep.equal({ source: "target", fallback: "{{fallback}}" }));
        console.log(pm.collectionVariables.get("secret")); pm.collectionVariables.set("secret", "rotated-child-secret"); console.log(pm.collectionVariables.get("secret")); pm.collectionVariables.set("changed", "yes"); pm.environment.set("nested", "yes");`,
    });
    const result = await context.runSingleRequest({
      workspaceId: ws.id,
      environmentId: env.id,
      folderId: root.id,
      saveHistory: false,
      request: request({ preRequestScript: `await pm.execution.runRequest(${JSON.stringify(child.id)});` }),
    });
    expect(result.scriptErrors).toEqual([]);
    expect(result.tests[0].passed).toBe(true);
    expect(JSON.stringify(result.logs)).not.toContain("child-secret-value");
    expect(JSON.stringify(result.logs)).not.toContain("rotated-child-secret");
    const variables = Object.fromEntries(
      repo.listVariables(ws.id, "collection", target.id).map((v) => [v.key, v.value]),
    );
    expect(variables.changed).toBe("yes");
    expect(variables.fallback).toBeUndefined();
    expect(result.scopes.collection).toEqual({ source: "root", fallback: "root-only" });
    expect(result.scopes.environment.nested).toBe("yes");
  });

  it("returns null for a skipped reference and does not adopt its flow control", async () => {
    const child = request({
      id: "child",
      preRequestScript: "pm.execution.skipRequest();",
      testScript: "throw new Error('unreached');",
    });
    const before = server.requests.length;
    const result = await execute({
      request: request({
        preRequestScript: `const response = await pm.execution.runRequest("child"); pm.test("skipped", () => pm.expect(response).to.equal(null));`,
      }),
      ancestors: [],
      scopes: emptyScopes(),
      resolveRequest: () => ({ request: child, ancestors: [] }),
    });
    expect(result.scriptErrors).toEqual([]);
    expect(result.tests[0].passed).toBe(true);
    expect(server.requests.length - before).toBe(1);
  });

  it("bounds recursive saved requests and records the nested error", async () => {
    const recursive = request({ preRequestScript: `await pm.execution.runRequest("root");` });
    const resolveRequest = vi.fn(() => ({ request: recursive, ancestors: [] }));
    const result = await execute({
      request: recursive,
      ancestors: [],
      scopes: emptyScopes(),
      resolveRequest,
    });
    expect(resolveRequest).toHaveBeenCalledTimes(5);
    expect(result.scriptErrors.some((e) => /recursion limit of 5/.test(e.message))).toBe(true);
  });

  it("applies host policy to nested requests", async () => {
    const result = await execute({
      request: request({ preRequestScript: `await pm.execution.runRequest("child");` }),
      ancestors: [],
      scopes: emptyScopes(),
      policy: new HostPolicy([], ["blocked.invalid"]),
      resolveRequest: () => ({ request: request({ url: "http://blocked.invalid/" }), ancestors: [] }),
    });
    expect(result.scriptErrors[0].message).toMatch(/denied|blocked/i);
  });

  it("cancels nested HTTP when the caller script times out", async () => {
    const resolveRequest = vi.fn(() => ({
      request: request({ url: `${server.url}/slow?ms=100` }),
      ancestors: [],
    }));
    const result = await execute({
      request: request({ preRequestScript: `await pm.execution.runRequest("child");` }),
      ancestors: [],
      scopes: emptyScopes(),
      resolveRequest,
      scriptLimits: { timeoutMs: 25 },
    });
    expect(result.scriptErrors.some((e) => /time limit/.test(e.message))).toBe(true);
    const logs = JSON.stringify(result.logs);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(JSON.stringify(result.logs)).toBe(logs);
  });
  it.each([true, false])(
    "honors persistVariables=%s for references outside the run folder",
    async (persistVariables) => {
      const ws = repo.createWorkspace("Nested run persistence");
      const root = repo.createFolder(ws.id, null);
      const target = repo.createFolder(ws.id, null);
      const child = repo.createRequest(ws.id, target.id, {
        url: `${server.url}/echo`,
        testScript: 'pm.collectionVariables.set("changed", "yes");',
      });
      repo.createRequest(ws.id, root.id, {
        url: `${server.url}/echo`,
        preRequestScript: `await pm.execution.runRequest(${JSON.stringify(child.id)});`,
      });
      const { startRun } = await import("@/server/runs");
      const { summary } = await startRun({
        workspaceId: ws.id,
        folderId: root.id,
        environmentId: null,
        options: { persistVariables },
      });
      expect(summary.status).toBe("passed");
      expect(repo.listVariables(ws.id, "collection", target.id).some((v) => v.key === "changed")).toBe(
        persistVariables,
      );
    },
  );

  it("keeps scope changes made before a referenced network failure", async () => {
    const result = await execute({
      request: request({
        preRequestScript: `try { await pm.execution.runRequest("child"); } catch (e) {} pm.test("partial changes", () => pm.expect(pm.environment.get("partial")).to.equal("yes"));`,
      }),
      ancestors: [],
      scopes: emptyScopes(),
      resolveRequest: () => ({
        request: request({
          url: "http://127.0.0.1:1/",
          preRequestScript: 'pm.environment.set("partial", "yes");',
        }),
        ancestors: [],
      }),
    });
    expect(result.scriptErrors).toEqual([]);
    expect(result.tests[0].passed).toBe(true);
    expect(result.scopes.environment.partial).toBe("yes");
  });
  it("retains referenced collection changes in memory when persistence is disabled", async () => {
    const a = {
      id: "a",
      name: "A",
      auth: { type: "none" as const },
      headers: [],
      preRequestScript: "",
      testScript: "",
    };
    const b = { ...a, id: "b", name: "B" };
    const result = await execute({
      request: request({
        preRequestScript: `await pm.execution.runRequest("child"); const second = await pm.execution.runRequest("child"); pm.test("counter", () => pm.expect(second.json().query.count).to.equal("1"));`,
      }),
      ancestors: [a],
      scopes: emptyScopes(),
      resolveRequest: () => ({
        ancestors: [b],
        collectionVariables: {},
        request: request({
          url: `${server.url}/echo?count={{count}}`,
          preRequestScript:
            'pm.collectionVariables.set("count", pm.collectionVariables.get("next") || "0"); pm.collectionVariables.set("next", "1");',
        }),
      }),
    });
    expect(result.scriptErrors).toEqual([]);
    expect(result.tests).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "counter", passed: true })]),
    );
    expect(result.scopes.collection).toEqual({});
  });

  it("returns nested changes to the root collection through a different collection", async () => {
    const a = {
      id: "a",
      name: "A",
      auth: { type: "none" as const },
      headers: [],
      preRequestScript: "",
      testScript: "",
    };
    const b = { ...a, id: "b", name: "B" };
    const result = await execute({
      request: request({
        preRequestScript: `await pm.execution.runRequest("in-b"); pm.test("nested owner", () => pm.expect(pm.collectionVariables.get("changed")).to.equal("yes"));`,
      }),
      ancestors: [a],
      scopes: emptyScopes(),
      resolveRequest: (id) =>
        id === "in-b"
          ? {
              ancestors: [b],
              request: request({ preRequestScript: 'await pm.execution.runRequest("in-a");' }),
            }
          : {
              ancestors: [a],
              request: request({ preRequestScript: 'pm.collectionVariables.set("changed", "yes");' }),
            },
    });
    expect(result.scriptErrors).toEqual([]);
    expect(result.tests[0]).toMatchObject({ name: "nested owner", passed: true });
    expect(result.scopes.collection.changed).toBe("yes");
  });
});
