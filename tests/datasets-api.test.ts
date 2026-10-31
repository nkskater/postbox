import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-datasets-"));
process.env.DATABASE_PATH = path.join(directory, "test.db");
let repo: typeof import("@/server/repo"),
  datasets: typeof import("@/server/datasets"),
  runs: typeof import("@/server/runs"),
  scheduler: typeof import("@/server/scheduler"),
  route: typeof import("@/app/api/datasets/[id]/route");
let client: Client, server: http.Server, base: string;
const received: string[] = [];
beforeAll(async () => {
  repo = await import("@/server/repo");
  datasets = await import("@/server/datasets");
  runs = await import("@/server/runs");
  scheduler = await import("@/server/scheduler");
  route = await import("@/app/api/datasets/[id]/route");
  const mcp = await import("@/app/api/mcp/route");
  client = new Client({ name: "dataset-test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://localhost/api/mcp"), {
      fetch: async (input, init) => {
        const req = new Request(input, init);
        return req.method === "POST" ? mcp.POST(req) : req.method === "GET" ? mcp.GET() : mcp.DELETE();
      },
    }),
  );
  server = http.createServer((req, res) => {
    received.push(req.url!);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ url: req.url }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  scheduler.stopScheduler();
  await client?.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const { getSqlite } = await import("@/server/db");
  getSqlite().close();
  fs.rmSync(directory, { recursive: true, force: true });
});
const table = {
  columns: ["id", "token"],
  rows: [
    { id: "1", token: "dataset-sensitive-one" },
    { id: "2", token: "dataset-sensitive-two" },
  ],
};
const create = () => {
  const ws = repo.createWorkspace("Datasets"),
    folder = repo.createFolder(ws.id, null);
  const dataset = datasets.createDataset(ws.id, { name: "Named data", table, secretColumns: ["token"] });
  return { ws, folder, dataset };
};
function parsed(result: Awaited<ReturnType<Client["callTool"]>>) {
  expect(result.isError).not.toBe(true);
  return JSON.parse((result.content as { text: string }[])[0].text);
}
describe("versioned saved datasets", () => {
  it("creates immutable versions, renames independently, rejects stale writes and hides secret values by default", () => {
    const { dataset } = create();
    expect(dataset.version).toBe(1);
    expect(dataset.table.rows[0].token).toBe("[REDACTED]");
    const next = datasets.createDatasetVersion(dataset.id, {
      expectedVersion: 1,
      table: { columns: ["id"], rows: [{ id: "new" }] },
      secretColumns: [],
    });
    expect(next.version).toBe(2);
    expect(datasets.getDataset(dataset.id, { version: 1, includeSecrets: true }).table).toEqual(table);
    expect(datasets.listDatasetVersions(dataset.id).map((version) => version.version)).toEqual([2, 1]);
    expect(() =>
      datasets.createDatasetVersion(dataset.id, { expectedVersion: 1, table, secretColumns: ["token"] }),
    ).toThrow(/changed/);
    expect(datasets.updateDataset(dataset.id, { name: "Renamed" })).toMatchObject({
      name: "Renamed",
      latestVersion: 2,
    });
  });
  it("exports masked packages by default, explicit secrets on consent, and imports stable versions", () => {
    const { ws, dataset } = create();
    const safe = datasets.exportDataset(dataset.id);
    expect(safe.missingSecrets).toBe(true);
    expect(JSON.stringify(safe)).not.toContain("dataset-sensitive");
    const restored = datasets.importDataset(ws.id, { format: "package", content: JSON.stringify(safe) });
    expect(restored.missingSecrets).toBe(true);
    expect(() => datasets.requireDatasetRef(ws.id, { id: restored.id }, { runnable: true })).toThrow(
      /omitted/,
    );
    const complete = datasets.exportDataset(dataset.id, { includeSecrets: true });
    expect(complete.table).toEqual(table);
    const imported = datasets.importDataset(ws.id, { format: "package", content: JSON.stringify(complete) });
    expect(datasets.getDataset(imported.id, { includeSecrets: true }).table).toEqual(table);
    const supplied = datasets.createDatasetVersion(restored.id, {
      expectedVersion: 1,
      table,
      secretColumns: ["token"],
    });
    expect(supplied.missingSecrets).toBe(false);
  });
  it("reuses latest or pinned data in runs, records the resolved version, and redacts streams/results/persisted scope copies", async () => {
    const { ws, folder, dataset } = create();
    repo.createEnvironment(ws.id, "Environment");
    const env = repo.listEnvironments(ws.id)[0];
    repo.createRequest(ws.id, folder.id, {
      url: base + "/echo?id={{id}}&token={{token}}",
      testScript:
        'console.log(pm.iterationData.get("token")); pm.environment.set("copied", pm.iterationData.get("token")); pm.test("ok",()=>pm.expect(pm.response.code).to.equal(200));',
    });
    const events: unknown[] = [];
    const result = await runs.startRun({
      workspaceId: ws.id,
      folderId: folder.id,
      environmentId: env.id,
      dataset: { id: dataset.id },
      onEvent: (event) => events.push(event),
    });
    expect(result.summary).toMatchObject({
      iterations: 2,
      totalRequests: 2,
      dataset: { id: dataset.id, version: 1 },
    });
    expect(received.some((url) => url.includes("dataset-sensitive-one"))).toBe(true);
    expect(JSON.stringify({ result, events, persisted: runs.getRunSummary(result.runId) })).not.toContain(
      "dataset-sensitive",
    );
    expect(
      repo.listVariables(ws.id, "environment", env.id).find((variable) => variable.key === "copied"),
    ).toMatchObject({ type: "secret", value: "dataset-sensitive-two" });
    datasets.createDatasetVersion(dataset.id, {
      expectedVersion: 1,
      table: { columns: ["id", "token"], rows: [{ id: "latest", token: "latest-sensitive" }] },
      secretColumns: ["token"],
    });
    const latest = await runs.startRun({
      workspaceId: ws.id,
      folderId: folder.id,
      environmentId: null,
      dataset: { id: dataset.id },
      options: { persistVariables: false },
    });
    expect(latest.summary).toMatchObject({ iterations: 1, dataset: { version: 2 } });
    const pinned = await runs.startRun({
      workspaceId: ws.id,
      folderId: folder.id,
      environmentId: null,
      dataset: { id: dataset.id, version: 1 },
      options: { persistVariables: false },
    });
    expect(pinned.summary).toMatchObject({ iterations: 2, dataset: { version: 1 } });
  });
  it("honors schedule references and rejects deletion until references are detached", async () => {
    const { ws, folder, dataset } = create();
    repo.createRequest(ws.id, folder.id, { url: base + "/scheduled?id={{id}}" });
    const schedule = scheduler.createSchedule({
      workspaceId: ws.id,
      folderId: folder.id,
      name: "Dataset schedule",
      cron: "0 0 * * *",
      enabled: false,
      dataset: { id: dataset.id, version: 1 },
    });
    expect(() => datasets.deleteDataset(dataset.id)).toThrow(/referenced/);
    const { runId } = await scheduler.runSchedule(schedule.id);
    const deadline = Date.now() + 5000;
    while (
      ["running", "queued"].includes(runs.listRuns(ws.id).find((run) => run.id === runId)?.status ?? "")
    ) {
      expect(Date.now()).toBeLessThan(deadline);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(runs.getRunSummary(runId)).toMatchObject({
      status: "passed",
      totalRequests: 2,
      dataset: { version: 1 },
    });
    scheduler.updateSchedule(schedule.id, { dataset: null });
    datasets.deleteDataset(dataset.id);
    expect(() => datasets.getDataset(dataset.id)).toThrow(/not found/i);
    expect(runs.getRunSummary(runId)?.dataset?.version).toBe(1);
  });
  it("exposes the same create/version/export/run behavior through MCP", async () => {
    const { ws, folder } = create();
    repo.createRequest(ws.id, folder.id, { url: base + "/mcp?id={{id}}" });
    const made = parsed(
      await client.callTool({
        name: "create_dataset",
        arguments: { workspaceId: ws.id, name: "MCP dataset", table, secretColumns: ["token"] },
      }),
    );
    expect(made.table.rows[0].token).toBe("[REDACTED]");
    const read = parsed(
      await client.callTool({ name: "get_dataset", arguments: { datasetId: made.id, includeSecrets: true } }),
    );
    expect(read.table).toEqual(table);
    const run = parsed(
      await client.callTool({
        name: "run_collection",
        arguments: { folderId: folder.id, dataset: { id: made.id } },
      }),
    );
    expect(run.summary.totalRequests).toBe(2);
    const exported = parsed(
      await client.callTool({ name: "export_dataset", arguments: { datasetId: made.id } }),
    );
    expect(exported.missingSecrets).toBe(true);
    const bad = await client.callTool({
      name: "run_collection",
      arguments: { folderId: folder.id, dataset: { id: made.id }, dataCsv: "id\n1" },
    });
    expect(bad.isError).toBe(true);
  });
  it("resolves queued latest data after admission, preserves pins and blocks deletion until cancellation", async () => {
    const { ws, folder, dataset } = create();
    repo.createRequest(ws.id, folder.id, { url: base + "/queued?id={{id}}" });
    const held = Array.from({ length: runs.runQueue.stats().maxActive }, () => runs.reserveRun());
    let latestId = "",
      pinnedId = "",
      cancelledId = "";
    const latest = runs.startRun({
      workspaceId: ws.id,
      folderId: folder.id,
      environmentId: null,
      dataset: { id: dataset.id },
      onEvent: (event) => {
        if (event.type === "queued") latestId = event.runId;
        if (event.type === "start") expect(() => datasets.deleteDataset(dataset.id)).toThrow(/referenced/);
      },
    });
    const pinned = runs.startRun({
      workspaceId: ws.id,
      folderId: folder.id,
      environmentId: null,
      dataset: { id: dataset.id, version: 1 },
      onEvent: (event) => {
        if (event.type === "queued") pinnedId = event.runId;
      },
    });
    const cancelled = runs.startRun({
      workspaceId: ws.id,
      folderId: folder.id,
      environmentId: null,
      dataset: { id: dataset.id },
      onEvent: (event) => {
        if (event.type === "queued") cancelledId = event.runId;
      },
    });
    try {
      expect(latestId).toBeTruthy();
      expect(pinnedId).toBeTruthy();
      expect(cancelledId).toBeTruthy();
      expect(datasets.datasetReferences(dataset.id).runs).toHaveLength(3);
      expect(() => datasets.deleteDataset(dataset.id)).toThrow(/referenced/);
      expect(runs.cancelRun(cancelledId)).toBe(true);
      expect((await cancelled).summary.status).toBe("cancelled");
      datasets.createDatasetVersion(dataset.id, {
        expectedVersion: 1,
        table: { columns: ["id"], rows: [{ id: "queued-latest" }] },
        secretColumns: [],
      });
    } finally {
      for (const ticket of held) ticket.release();
    }
    const results = await Promise.all([latest, pinned]);
    expect(results[0].summary).toMatchObject({ iterations: 1, dataset: { version: 2 } });
    expect(results[1].summary).toMatchObject({ iterations: 2, dataset: { version: 1 } });
    expect(datasets.datasetReferences(dataset.id).runs).toHaveLength(0);
    datasets.deleteDataset(dataset.id);
  });
  it("redacts dataset copies and mutated declared secrets from nested saved requests", async () => {
    const { ws, folder, dataset } = create();
    const childFolder = repo.createFolder(ws.id, null, { name: "Child" });
    repo.replaceVariables(ws.id, "collection", childFolder.id, [
      { key: "declared", value: "child-initial", type: "secret", enabled: true },
    ]);
    repo.replaceVariables(ws.id, "collection", folder.id, [
      { key: "declared", value: "parent-initial", type: "secret", enabled: true },
    ]);
    const child = repo.createRequest(ws.id, childFolder.id, {
      name: "Child",
      url: base + "/child?token={{token}}",
      testScript:
        'pm.collectionVariables.set("declared", "nested-sensitive-value"); pm.collectionVariables.set("childCopy", pm.iterationData.get("token")); console.log(pm.iterationData.get("token"), pm.collectionVariables.get("declared"));',
    });
    repo.createRequest(ws.id, folder.id, {
      url: base + "/parent?token={{token}}",
      testScript: `await pm.execution.runRequest("${child.id}"); pm.collectionVariables.set("declared", "mutated-sensitive-value"); pm.collectionVariables.set("parentCopy", pm.iterationData.get("token")); console.log(pm.iterationData.get("token"), pm.collectionVariables.get("declared"));`,
    });
    const events: unknown[] = [];
    const result = await runs.startRun({
      workspaceId: ws.id,
      folderId: folder.id,
      environmentId: null,
      dataset: { id: dataset.id },
      onEvent: (event) => events.push(event),
    });
    expect(result.summary.status).toBe("passed");
    const serialized = JSON.stringify({ result, events, stored: runs.getRunSummary(result.runId) });
    for (const value of ["dataset-sensitive", "nested-sensitive-value", "mutated-sensitive-value"])
      expect(serialized).not.toContain(value);
    expect(
      repo.listVariables(ws.id, "collection", childFolder.id).find((v) => v.key === "childCopy"),
    ).toMatchObject({ type: "secret", value: "dataset-sensitive-two" });
    expect(
      repo.listVariables(ws.id, "collection", folder.id).find((v) => v.key === "parentCopy"),
    ).toMatchObject({ type: "secret", value: "dataset-sensitive-two" });
  });
  it("limits previews without truncating exports and rejects foreign REST run sources before admission", async () => {
    const { ws, folder, dataset } = create();
    const context = { params: Promise.resolve({ id: dataset.id }) };
    const preview = await route.GET(
      new Request(`http://localhost/api/datasets/${dataset.id}?previewRows=1`),
      context,
    );
    const document = await preview.json();
    expect(document.rows).toBe(2);
    expect(document.table.rows).toHaveLength(1);
    const exporter = await import("@/app/api/datasets/[id]/export/route");
    const response = await exporter.GET(
      new Request(`http://localhost/api/datasets/${dataset.id}/export?previewRows=1`),
      context,
    );
    expect((await response.json()).table.rows).toHaveLength(2);
    const foreign = repo.createWorkspace("Foreign dataset"),
      source = datasets.createDataset(foreign.id, { name: "foreign", table });
    const runsRoute = await import("@/app/api/runs/route");
    const before = runs.runQueue.stats();
    const bad = await runsRoute.POST(
      new Request("http://localhost/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId: ws.id, folderId: folder.id, dataset: { id: source.id } }),
      }),
    );
    expect(bad.status).toBe(404);
    expect(runs.runQueue.stats()).toEqual(before);
    expect(runs.listRuns(ws.id)).toHaveLength(0);
  });
  it("enforces read/write membership, secret-value consent and cross-workspace references", async () => {
    const users = await import("@/server/users"),
      { withCaller } = await import("@/server/access-context"),
      { setMember } = await import("@/server/authorize");
    await users.createUser({ username: "admin", password: "password123", isAdmin: true });
    const owner = await users.createUser({ username: "owner", password: "password123" }),
      viewer = await users.createUser({ username: "viewer", password: "password123" }),
      outsider = await users.createUser({ username: "outsider", password: "password123" });
    const caller = { kind: "user" as const, user: owner, via: "token" as const };
    const ws = withCaller(caller, () => repo.createWorkspace("Private"));
    withCaller(caller, () => setMember(ws.id, viewer.username, "viewer"));
    const doc = datasets.createDataset(ws.id, { name: "Protected", table, secretColumns: ["token"] });
    const invoke = (user: typeof owner, query = "") =>
      route.GET(
        new Request(`http://localhost/api/datasets/${doc.id}${query}`, {
          headers: { authorization: `Bearer ${users.createToken(user.id, "test").token}` },
        }),
        { params: Promise.resolve({ id: doc.id }) },
      );
    const read = await invoke(viewer);
    expect(read.status).toBe(200);
    expect(JSON.stringify(await read.json())).not.toContain("dataset-sensitive");
    expect((await invoke(viewer, "?includeSecrets=1")).status).toBe(403);
    expect((await invoke(outsider)).status).toBe(404);
    const foreign = repo.createWorkspace("Other");
    expect(() => datasets.requireDatasetRef(foreign.id, { id: doc.id })).toThrow(/not found/i);
    repo.deleteWorkspace(ws.id);
    expect(() => datasets.getDataset(doc.id)).toThrow(/not found/i);
  });
});
