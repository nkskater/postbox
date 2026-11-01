import { beforeAll, afterAll, describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-visualizer-"));
process.env.DATABASE_PATH = path.join(directory, "test.db");
let server: http.Server,
  base: string,
  hits = 0,
  repo: typeof import("@/server/repo"),
  context: typeof import("@/server/context");
beforeAll(async () => {
  repo = await import("@/server/repo");
  context = await import("@/server/context");
  server = http.createServer((_req, res) => {
    hits++;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ name: "Alice", value: 3, token: "response-private-value" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  (await import("@/server/db")).getSqlite().close();
  fs.rmSync(directory, { recursive: true, force: true });
});
function setup() {
  const ws = repo.createWorkspace("Visualization"),
    folder = repo.createFolder(ws.id, null, {
      preRequestScript: 'pm.visualizer.set("<p>{{name}}</p>",{name:"from collection"});',
    }),
    env = repo.createEnvironment(ws.id, "Env", [
      { key: "private", value: "environment-private-value", type: "secret", enabled: true },
    ]);
  const request = repo.createRequest(ws.id, folder.id, {
    url: base,
    testScript:
      'pm.test("pre visualization",()=>pm.expect(pm.visualizer.get().data.name).to.equal("from collection"));pm.environment.set("private","updated-private-value");pm.visualizer.set("<h1>{{name}}</h1><p>{{token}} {{private}}</p>",{name:pm.response.json().name,token:pm.response.json().token,private:pm.environment.get("private")});',
  });
  return { ws, folder, env, request };
}
describe("visualization execution and API", () => {
  it("propagates pre/post templates and redacts response and updated environment credentials", async () => {
    const { ws, folder, env, request } = setup();
    const result = await context.runSingleRequest({
      workspaceId: ws.id,
      folderId: folder.id,
      environmentId: env.id,
      request,
    });
    expect(result.tests[0].passed).toBe(true);
    expect(result.visualizationResult?.error).toBeUndefined();
    expect(result.visualizationResult?.html).toContain("Alice");
    for (const secret of ["response-private-value", "environment-private-value", "updated-private-value"])
      expect(
        JSON.stringify({ view: result.visualizationResult, source: result.visualization }),
      ).not.toContain(secret);
    const history = repo.listHistory(ws.id);
    expect(history).toHaveLength(1);
    expect(JSON.stringify(repo.getHistory(history[0].id))).not.toContain("visualizationResult");
  });
  it("returns current visualizations through REST and clears them on subsequent sends", async () => {
    const { ws, folder, env, request } = setup();
    const { POST } = await import("@/app/api/proxy/route");
    const invoke = (requestValue: typeof request) =>
      POST(
        new Request("http://localhost/api/proxy", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspaceId: ws.id,
            folderId: folder.id,
            environmentId: env.id,
            request: requestValue,
          }),
        }),
      );
    const first = await invoke(request);
    expect(first.status).toBe(200);
    const rendered = await first.json();
    expect(rendered.visualizationResult.html).toContain("<h1>Alice</h1>");
    const cleared = await (await invoke({ ...request, testScript: "pm.visualizer.clear();" })).json();
    expect(cleared.visualization).toBeNull();
    expect(cleared.visualizationResult).toBeUndefined();
  });
  it("reports malicious template failures without extra network requests and supports a later clean render", async () => {
    const { ws, folder, env, request } = setup();
    const before = hits;
    const failed = await context.runSingleRequest({
      workspaceId: ws.id,
      folderId: folder.id,
      environmentId: env.id,
      request: {
        ...request,
        testScript: 'pm.visualizer.set("<script>fetch(\\\"https://evil.test\\\")</script>",{});',
      },
    });
    expect(failed.visualizationResult?.error).toBeTruthy();
    expect(hits - before).toBe(1);
    const next = await context.runSingleRequest({
      workspaceId: ws.id,
      folderId: folder.id,
      environmentId: env.id,
      request: { ...request, testScript: 'pm.visualizer.set("<p>clean</p>",{});' },
    });
    expect(next.visualizationResult?.error).toBeUndefined();
    expect(next.visualizationResult?.html).toContain("<p>clean</p>");
  });
});
