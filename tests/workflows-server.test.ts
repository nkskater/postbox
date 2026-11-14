import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { parseGraph, starterGraph, type FlowGraph } from "@/core/workflows/model";
import type { StartFlowInput } from "@/server/workflows/runner";
import type { Caller } from "@/server/caller";
import type { UserRow } from "@/server/db/schema";
import { startTestServer, type TestServer } from "./helpers/server";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-workflows-"));
process.env.DATABASE_PATH = path.join(dir, "test.db");
process.env.POSTBOX_VAULT_KEY_FILE = path.join(dir, "keys.json");
delete process.env.POSTBOX_VAULT_KEY;
const { getDb, getSqlite, schema } = await import("@/server/db");
const users = await import("@/server/users");
const repo = await import("@/server/repo");
const vault = await import("@/server/vault");
const keys = await import("@/server/vault-keys");
const flow = await import("@/server/workflows");
const { openArtifact, versionRow } = await import("@/server/workflows/artifacts");
const { resolveActor } = await import("@/server/workflows/actor");
const { flowState, cancelMatching } = await import("@/server/workflows/state");
const schedules = await import("@/server/workflows/scheduler");
const { withCaller } = await import("@/server/access-context");
const { setMember } = await import("@/server/authorize");
const triggerRoute = await import("@/app/api/workflow-triggers/[id]/route");
const runRoute = await import("@/app/api/workflows/[id]/runs/route");
const previewRoute = await import("@/app/api/workflows/[id]/preview/route");
let owner: UserRow, admin: UserRow, viewer: UserRow, editor: UserRow, outsider: UserRow;
let workspaceId: string, folderId: string, requestId: string, otherWorkspace: string;
let target: TestServer;
const tokens: Record<string, string> = {};
const caller = (user: UserRow): Caller => ({ kind: "user", user, via: "session" });
const as = <T>(user: UserRow, work: () => T) => withCaller(caller(user), work);
const requestGraph = (): FlowGraph =>
  parseGraph({
    schema: 1,
    entry: "http",
    nodes: [
      {
        id: "http",
        label: "Echo",
        position: { x: 0, y: 0 },
        type: "request",
        requestId,
        next: "out",
        bindings: { payload: { kind: "path", path: "input.payload" } },
      },
      {
        id: "out",
        label: "Result",
        position: { x: 250, y: 0 },
        type: "output",
        expression: { kind: "path", path: "value.data" },
      },
    ],
  });
const make = (graph = starterGraph()) =>
  as(owner, () => flow.createWorkflow({ workspaceId, name: "Test flow", graph }));
const run = async (id: string, options: Partial<StartFlowInput> = {}, user = owner) => {
  const started = as(user, () =>
    flow.startFlowRun({ workflowId: id, input: {}, source: "manual", ...options }),
  );
  return flow.waitForFlowRun(started.runId);
};
const webhook = async (
  id: string,
  token: string,
  input: unknown = {},
  key?: string,
  contentType = "application/json",
) => {
  const res = await triggerRoute.POST(
    new Request(`http://localhost/api/workflow-triggers/${id}?wait=1`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": contentType,
        ...(key ? { "idempotency-key": key } : {}),
      },
      body: JSON.stringify(input),
    }),
    { params: Promise.resolve({ id }) },
  );
  return { status: res.status, body: await res.json() };
};
beforeAll(async () => {
  target = await startTestServer();
  admin = await users.createUser({ username: "admin", password: "password123", isAdmin: true });
  owner = await users.createUser({ username: "owner", password: "password123" });
  viewer = await users.createUser({ username: "viewer", password: "password123" });
  editor = await users.createUser({ username: "editor", password: "password123" });
  outsider = await users.createUser({ username: "outsider", password: "password123" });
  workspaceId = as(owner, () => repo.createWorkspace("Flows")).id;
  otherWorkspace = as(outsider, () => repo.createWorkspace("Private")).id;
  as(owner, () => {
    setMember(workspaceId, viewer.username, "viewer");
    setMember(workspaceId, editor.username, "editor");
  });
  folderId = repo.createFolder(workspaceId, null, { name: "Collection" }).id;
  requestId = repo.createRequest(workspaceId, folderId, {
    name: "Echo",
    method: "POST",
    url: `${target.url}/echo?revision=one`,
    body: { mode: "raw", raw: "{{flow.payload}}", language: "text" },
    auth: { type: "bearer", bearer: { token: "pinned-credential-7ff263ab" } },
  }).id;
  for (const user of [owner, viewer, editor, outsider])
    tokens[user.id] = users.createToken(user.id, "Test").token;
});
afterAll(async () => {
  schedules.stopWorkflowScheduler();
  cancelMatching(() => true);
  await Promise.all([...flowState.active.values()].map((v) => v.completion));
  await target.close();
  getSqlite().close();
  fs.rmSync(dir, { recursive: true, force: true });
});
describe("workflow versions and execution", () => {
  it("pins HTTP content and encrypts snapshots while redacting retained outputs", async () => {
    const saved = make(requestGraph());
    const version = as(owner, () => flow.publishVersion(saved.id, saved.revision));
    const snapshot = versionRow(saved.id, version.version);
    expect(snapshot.artifact).not.toContain("pinned-credential");
    expect(JSON.stringify(as(viewer, () => flow.getWorkflow(saved.id)))).not.toContain("artifact");
    repo.updateRequest(requestId, { url: `${target.url}/echo?revision=two` });
    const pinned = await run(saved.id, { version: 1, input: { payload: "{{private}}" } });
    expect(pinned.status).toBe("passed");
    expect(pinned.output).toMatchObject({ query: { revision: "one" }, body: "{{private}}" });
    expect(JSON.stringify(pinned)).not.toContain("pinned-credential-7ff263ab");
    expect(target.requests.at(-1)?.headers.authorization).toBe("Bearer pinned-credential-7ff263ab");
    expect((await run(saved.id, { input: { payload: "new" } })).output).toMatchObject({
      query: { revision: "two" },
      body: "new",
    });
    expect(pinned.contentHash).toBe(version.contentHash);
    expect(pinned.sourceRevision).toBeNull();
    const changed = as(owner, () =>
      flow.updateWorkflow(saved.id, { revision: saved.revision, name: "Renamed" }),
    );
    expect(() =>
      as(owner, () => flow.updateWorkflow(saved.id, { revision: saved.revision, name: "Stale" })),
    ).toThrow(/changed/);
    expect(() => as(owner, () => flow.publishVersion(saved.id, saved.revision))).toThrow(/changed/);
    as(owner, () => flow.publishVersion(saved.id, changed.revision));
    as(owner, () => flow.deleteVersion(saved.id, 2));
    expect(as(owner, () => flow.publishVersion(saved.id, changed.revision)).version).toBe(3);
  });
  it("keeps a published parent's pinned subflow after child version deletion", async () => {
    const child = make();
    as(owner, () => flow.publishVersion(child.id, 1));
    const parent = make(
      parseGraph({
        schema: 1,
        entry: "child",
        nodes: [
          {
            id: "child",
            label: "Child",
            position: { x: 0, y: 0 },
            type: "subflow",
            workflowId: child.id,
            version: 1,
            input: { kind: "path", path: "input" },
          },
        ],
      }),
    );
    as(owner, () => flow.publishVersion(parent.id, 1));
    as(owner, () => flow.deleteVersion(child.id, 1));
    expect((await run(parent.id, { version: 1, input: { hello: "world" } })).output).toEqual({
      hello: "world",
    });
    expect(() => as(owner, () => flow.publishVersion(parent.id, 1))).toThrow(/version/i);
  });
  it("rotates encrypted workflow snapshots before pruning their old key", async () => {
    const saved = make(requestGraph());
    as(owner, () => flow.publishVersion(saved.id, 1));
    const original = versionRow(saved.id, 1),
      oldKey = keys.getKeys().ring.current.id;
    as(admin, () => vault.rotateKeys({ newKey: true, prune: true }));
    expect(keys.getKeys().ring.all.has(oldKey)).toBe(false);
    const rotated = versionRow(saved.id, 1);
    expect(rotated.artifact).not.toBe(original.artifact);
    expect(rotated.contentHash).toBe(original.contentHash);
    expect((await run(saved.id, { version: 1, input: { payload: "rotated" } })).status).toBe("passed");
    getDb()
      .update(schema.workflowVersions)
      .set({ artifact: "broken" })
      .where(and(eq(schema.workflowVersions.workflowId, saved.id), eq(schema.workflowVersions.version, 1)))
      .run();
    expect(() => openArtifact(workspaceId, saved.id, 1)).toThrow(/unreadable/);
    expect(as(owner, () => flow.publishVersion(saved.id, 1)).version).toBe(2);
  });
  it("validates cross-workspace references before any HTTP request", () => {
    const foreignFolder = repo.createFolder(otherWorkspace, null).id;
    const foreignRequest = repo.createRequest(otherWorkspace, foreignFolder, {
      url: `${target.url}/echo`,
    }).id;
    const graph = requestGraph();
    if (graph.nodes[0].type === "request") graph.nodes[0].requestId = foreignRequest;
    const saved = make(graph),
      count = target.requests.length;
    expect(() => as(owner, () => flow.publishVersion(saved.id, 1))).toThrow();
    expect(() =>
      as(owner, () => flow.startFlowRun({ workflowId: saved.id, input: {}, source: "manual" })),
    ).toThrow();
    expect(target.requests).toHaveLength(count);
  });
  it("previews deterministic fixtures for readers without target HTTP", async () => {
    const saved = make(requestGraph()),
      before = target.requests.length;
    const result = await run(
      saved.id,
      { source: "fixture", fixtures: { [requestId]: { status: 200, data: { fixture: true } } } },
      viewer,
    );
    expect(result.status).toBe("passed");
    expect(result.output).toEqual({ fixture: true });
    expect(target.requests).toHaveLength(before);
    expect(() =>
      as(viewer, () => flow.startFlowRun({ workflowId: saved.id, input: {}, source: "manual" })),
    ).toThrow();
    expect(() => as(editor, () => flow.publishVersion(saved.id, 1))).toThrow();
    expect(() => as(outsider, () => flow.getWorkflow(saved.id))).toThrow();
    expect(() =>
      as(viewer, () =>
        flow.startFlowRun({
          workflowId: saved.id,
          input: {},
          source: "fixture",
          fixtures: { x: { data: "x".repeat(70000) } },
        }),
      ),
    ).toThrow(/limit|budget/i);
    expect((await run(saved.id, { input: { payload: "editor" } }, editor)).status).toBe("passed");
  });
  it("cancels active HTTP and records restart interruptions without replay", async () => {
    const slow = repo.createRequest(workspaceId, folderId, { url: `${target.url}/slow?ms=100` });
    const graph = requestGraph();
    if (graph.nodes[0].type === "request") graph.nodes[0].requestId = slow.id;
    const saved = make(graph),
      started = as(owner, () =>
        flow.startFlowRun({ workflowId: saved.id, input: { payload: "x" }, source: "manual" }),
      );
    as(owner, () => flow.cancelFlowRun(started.runId));
    expect((await flow.waitForFlowRun(started.runId)).status).toBe("cancelled");
    const old = flow.flowRunRow(started.runId);
    getDb()
      .insert(schema.workflowRuns)
      .values({ ...old, id: "orphan-flow-run", status: "running", finishedAt: null })
      .run();
    flowState.initialized = false;
    const count = target.requests.length;
    flow.initializeWorkflowRuns();
    expect(flow.flowRunRow("orphan-flow-run")).toMatchObject({
      status: "interrupted",
      error: expect.stringContaining("side effects"),
    });
    expect(target.requests).toHaveLength(count);
  });
});
describe("deployment capabilities", () => {
  const deploy = (options: Partial<Parameters<typeof flow.createDeployment>[1]> = {}) => {
    const saved = make();
    as(owner, () => flow.publishVersion(saved.id, 1));
    return as(owner, () =>
      flow.createDeployment(saved.id, {
        name: "Automation",
        version: 1,
        enabled: true,
        webhookEnabled: true,
        ...options,
      }),
    );
  };
  it("hashes bearer tokens, validates input and deduplicates retained webhook deliveries", async () => {
    const deployment = deploy(),
      token = deployment.token!;
    expect(JSON.stringify(as(owner, () => flow.getDeployment(deployment.id)))).not.toContain(token);
    expect(flow.deploymentRow(deployment.id).webhookHash).not.toBe(token);
    expect((await webhook(deployment.id, "invalid")).status).toBe(404);
    expect((await webhook(deployment.id, token, {}, undefined, "text/plain")).status).toBe(415);
    expect((await webhook(deployment.id, token, { x: "x".repeat(70000) })).status).toBe(413);
    const first = await webhook(deployment.id, token, { b: 2, a: 1 }, "delivery-one");
    expect(first).toMatchObject({
      status: 200,
      body: { status: "passed", output: { a: 1, b: 2 }, duplicate: false },
    });
    const duplicate = await webhook(deployment.id, token, { a: 1, b: 2 }, "delivery-one");
    expect(duplicate.body).toMatchObject({ runId: first.body.runId, duplicate: true });
    expect((await webhook(deployment.id, token, { a: 3 }, "delivery-one")).status).toBe(409);
    const rotated = as(owner, () => flow.rotateTriggerToken(deployment.id, deployment.revision));
    expect((await webhook(deployment.id, token)).status).toBe(404);
    expect((await webhook(deployment.id, rotated.token, null)).body.output).toBeNull();
    expect(() => as(owner, () => flow.deleteVersion(deployment.workflowId, 1))).toThrow(/deployments/);
    expect(() => as(owner, () => flow.deleteWorkflow(deployment.workflowId))).toThrow(/deployments/);
    expect(() => as(owner, () => flow.deleteDeployment(deployment.id))).toThrow(/Disable/);
    const disabled = as(owner, () =>
      flow.updateDeployment(deployment.id, { revision: rotated.revision, enabled: false }),
    );
    expect((await webhook(deployment.id, rotated.token)).status).toBe(404);
    expect(() =>
      as(owner, () => flow.updateDeployment(deployment.id, { revision: rotated.revision, name: "Stale" })),
    ).toThrow(/changed/);
    as(owner, () => flow.deleteDeployment(disabled.id));
  });
  it("invalidates a previous owner's disabled webhook when ownership changes", async () => {
    const deployment = deploy({ webhookEnabled: false });
    const token = as(owner, () => flow.rotateTriggerToken(deployment.id, 1)).token;
    const adopted = as(admin, () => flow.updateDeployment(deployment.id, { revision: 2, name: "Adopted" }));
    expect(adopted.webhookConfigured).toBe(false);
    const enabled = as(admin, () =>
      flow.updateDeployment(deployment.id, { revision: adopted.revision, webhookEnabled: true }),
    );
    expect(enabled.token).toBeTruthy();
    expect((await webhook(deployment.id, token)).status).toBe(404);
    expect((await webhook(deployment.id, enabled.token!)).body.status).toBe("passed");
  });
  it("fails closed for deleted environments while allowing emergency disable", async () => {
    const environment = repo.createEnvironment(workspaceId, "Transient");
    const deployment = deploy({ environmentId: environment.id });
    repo.deleteEnvironment(environment.id);
    expect((await webhook(deployment.id, deployment.token!)).status).toBe(400);
    expect(() =>
      as(owner, () => flow.updateDeployment(deployment.id, { revision: 1, name: "Still enabled" })),
    ).toThrow(/Environment/);
    expect(
      as(owner, () => flow.updateDeployment(deployment.id, { revision: 1, enabled: false })).enabled,
    ).toBe(false);
  });
  it("checks current account status, API key revocation and workspace role on every invocation", async () => {
    const temporary = await users.createUser({ username: "automation", password: "password123" });
    as(owner, () => setMember(workspaceId, temporary.username, "owner"));
    const saved = make();
    as(owner, () => flow.publishVersion(saved.id, 1));
    const key = users.createToken(temporary.id, "Automation");
    const tokenCaller: Caller = {
      kind: "user",
      user: temporary,
      via: "token",
      token: { id: key.info.id, scope: "full", rateLimitPerMinute: 0 },
    };
    const deployment = withCaller(tokenCaller, () =>
      flow.createDeployment(saved.id, { name: "Key-owned", version: 1, enabled: true, webhookEnabled: true }),
    );
    expect((await webhook(deployment.id, deployment.token!)).body.status).toBe("passed");
    users.revokeToken(temporary.id, key.info.id);
    expect((await webhook(deployment.id, deployment.token!)).status).toBe(403);
    const adopted = as(temporary, () => flow.updateDeployment(deployment.id, { revision: 1 }));
    users.setDisabled(temporary.id, true);
    expect((await webhook(deployment.id, adopted.token!)).status).toBe(403);
    users.setDisabled(temporary.id, false);
    as(owner, () => setMember(workspaceId, temporary.username, "viewer"));
    expect((await webhook(deployment.id, adopted.token!)).status).toBe(403);
    expect(() => resolveActor({ kind: "open" }, workspaceId)).toThrow();
  });
  it("runs minute UTC schedules and records a rejected owner without replaying missed ticks", async () => {
    const deployment = deploy({ cron: "* * * * *", webhookEnabled: false });
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    try {
      schedules.startWorkflowScheduler();
      expect(flow.deploymentRow(deployment.id).lastRunId).toBeNull();
      await vi.advanceTimersByTimeAsync(60001);
      const first = flow.deploymentRow(deployment.id).lastRunId!;
      expect(first).toBeTruthy();
      expect(flow.flowRunRow(first)).toMatchObject({ source: "schedule", status: "passed" });
      await vi.advanceTimersByTimeAsync(60000);
      expect(flow.deploymentRow(deployment.id).lastRunId).not.toBe(first);
      users.setDisabled(owner.id, true);
      await vi.advanceTimersByTimeAsync(60000);
      expect(flow.deploymentRow(deployment.id).lastError).toContain("unavailable");
    } finally {
      users.setDisabled(owner.id, false);
      schedules.stopWorkflowScheduler();
      vi.useRealTimers();
    }
  });
  it("enforces REST run/preview roles and rejects client-supplied execution identity", async () => {
    const saved = make();
    const send = async (handler: typeof runRoute.POST, user: UserRow, body: unknown) =>
      handler(
        new Request(
          `http://localhost/api/workflows/${saved.id}/${handler === previewRoute.POST ? "preview" : "runs"}`,
          {
            method: "POST",
            headers: { authorization: `Bearer ${tokens[user.id]}`, "content-type": "application/json" },
            body: JSON.stringify(body),
          },
        ),
        { params: Promise.resolve({ id: saved.id }) },
      );
    expect((await send(runRoute.POST, viewer, {})).status).toBe(403);
    expect((await send(runRoute.POST, outsider, {})).status).toBe(404);
    expect((await send(runRoute.POST, owner, { actor: { kind: "open" } })).status).toBe(400);
    expect((await send(runRoute.POST, owner, { fixtures: {} })).status).toBe(400);
    const response = await send(previewRoute.POST, viewer, { input: { preview: true } });
    expect(response.status).toBe(202);
    expect((await flow.waitForFlowRun((await response.json()).runId)).output).toEqual({ preview: true });
  });
});

it("backs up workflow configuration, disables restored triggers and omits snapshots without secrets", async () => {
  const { createBackup, restoreBackup } = await import("@/server/backup");
  const { openDatabase } = await import("@/server/db");
  const saved = make(requestGraph());
  as(owner, () => flow.publishVersion(saved.id, 1));
  const deployed = as(owner, () =>
    flow.createDeployment(saved.id, {
      name: "Backed up automation",
      version: 1,
      enabled: true,
      webhookEnabled: true,
    }),
  );
  const complete = createBackup(getDb(), { includeSecrets: true });
  expect(complete.tables.workflows.some((row) => row.id === saved.id)).toBe(true);
  expect(complete.tables.workflowVersions.some((row) => row.workflowId === saved.id)).toBe(true);
  expect(complete.tables.workflowDeployments.some((row) => row.id === deployed.id)).toBe(true);
  const clean = createBackup(getDb(), { includeSecrets: false });
  expect(clean.tables.workflowVersions).toEqual([]);
  expect(clean.tables.workflowDeployments).toEqual([]);
  const target = openDatabase(path.join(dir, "workflow-backup.db"));
  try {
    restoreBackup(target.db, target.sqlite, JSON.parse(JSON.stringify(complete)));
    expect(
      target.db
        .select()
        .from(schema.workflowDeployments)
        .where(eq(schema.workflowDeployments.id, deployed.id))
        .get(),
    ).toMatchObject({ enabled: false, webhookHash: null, lastRunId: null });
    expect(
      target.db.select().from(schema.workflows).where(eq(schema.workflows.id, saved.id)).get(),
    ).toMatchObject({ name: saved.name, graph: saved.graph, createdBy: null });
    expect(target.sqlite.pragma("foreign_key_check")).toEqual([]);
  } finally {
    target.sqlite.close();
  }
});
