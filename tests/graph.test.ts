import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractSources, hostOf, type WorkspaceSnapshot } from "@/core/graph/extract";
import { buildView, searchNodes, shortestPath, traverse } from "@/core/graph/query";
import type { Caller } from "@/server/caller";
import type { UserRow } from "@/server/db/schema";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-graph-"));
process.env.DATABASE_PATH = path.join(dir, "db.sqlite");
const users = await import("@/server/users");
const repo = await import("@/server/repo");
const graph = await import("@/server/graph");
const capture = await import("@/server/capture");
const { withCaller } = await import("@/server/access-context");
const { setMember } = await import("@/server/authorize");
const { getDb, getSqlite, schema } = await import("@/server/db");
const searchRoute = await import("@/app/api/graph/search/route");
const traverseRoute = await import("@/app/api/graph/traverse/route");
const sourcesRoute = await import("@/app/api/graph/sources/route");
const tokens: Record<string, string> = {};

const caller = (user: UserRow): Caller => ({ kind: "user", user, via: "token" });

// ------------------------------------------------------------------ fixtures

const snapshot = (): WorkspaceSnapshot => ({
  workspaceId: "w1",
  folders: [
    { id: "c1", parentId: null, name: "Billing" },
    { id: "f1", parentId: "c1", name: "Invoices" },
    { id: "c2", parentId: null, name: "Search" },
  ],
  requests: [
    { id: "r1", folderId: "f1", name: "List invoices", method: "GET", url: "{{baseUrl}}/v1/invoices" },
    {
      id: "r2",
      folderId: "f1",
      name: "Get invoice",
      method: "GET",
      url: "https://api.pay.test/v1/invoices/{{id}}",
    },
    {
      id: "r3",
      folderId: "c2",
      name: "Query",
      method: "POST",
      url: "https://user:pw@search.test:8443/q?token=abc",
    },
  ],
  environments: [
    {
      id: "e1",
      name: "Staging",
      variables: [
        { key: "baseUrl", value: "https://staging.pay.test", secret: false, enabled: true },
        { key: "apiKey", value: "https://leaky.test", secret: true, enabled: true },
      ],
    },
    {
      id: "e2",
      name: "Production",
      variables: [{ key: "baseUrl", value: "https://api.pay.test", secret: false, enabled: true }],
    },
  ],
  globals: [],
  collectionVariables: {},
  specifications: [
    {
      id: "s1",
      name: "Payments",
      format: "openapi",
      revision: 1,
      servers: ["https://api.pay.test/v1"],
      operations: ["GET /invoices", "GET /invoices/{invoiceId}", "POST /refunds"],
    },
  ],
  links: [{ folderId: "c1", specificationId: "s1", version: 1 }],
  mocks: [{ id: "m1", name: "Billing mock", folderId: "c1", enabled: true }],
  monitors: [{ id: "mo1", name: "Nightly billing", folderId: "c1", enabled: true, state: "healthy" }],
  catalog: [{ id: "k1", title: "Billing API", folderId: "c1", enabled: true, visibility: "team" }],
  webhooks: [{ id: "h1", name: "Alerts", url: "https://hooks.chat.test/T000/secret-path", enabled: true }],
  captures: [
    {
      id: "cap1",
      name: "Browser",
      state: "recording",
      hosts: [{ host: "api.pay.test", requests: 12, lastAt: 5 }],
    },
  ],
});

const build = (s = snapshot()) => {
  const facts = extractSources(s);
  return {
    facts,
    view: buildView(
      facts.flatMap((f) => f.nodes),
      facts.flatMap((f) => f.edges),
    ),
  };
};

// ------------------------------------------------------------------ pure rules

describe("hosts", () => {
  it("keeps only the host, dropping credentials, paths, queries and default ports", () => {
    expect(hostOf("https://user:pw@API.Example.com/a?token=1#x")).toBe("api.example.com");
    expect(hostOf("https://example.com:443/x")).toBe("example.com");
    expect(hostOf("http://example.com:8080/x")).toBe("example.com:8080");
    expect(hostOf("//example.com/x")).toBe("example.com");
    expect(hostOf("example.com/x")).toBe("example.com");
    expect(hostOf("{{baseUrl}}/x")).toBeNull();
    expect(hostOf("https://{{host}}/x")).toBeNull();
    expect(hostOf("")).toBeNull();
  });
});

describe("extracting facts", () => {
  it("is deterministic: the same snapshot gives identical fingerprints", () => {
    const a = extractSources(snapshot()).map((f) => [f.id, f.fingerprint]);
    const b = extractSources(snapshot()).map((f) => [f.id, f.fingerprint]);
    expect(a).toEqual(b);
    expect(new Set(a.map(([id]) => id)).size).toBe(a.length);
  });

  it("links requests to every host their variables can resolve to, ignoring secret variables", () => {
    const { view } = build();
    const hosts = (view.forward.get("request:r1") ?? []).filter((e) => e.type === "calls").map((e) => e.to);
    expect(hosts.sort()).toEqual(["service:api.pay.test", "service:staging.pay.test"]);
    expect(view.nodes.has("service:leaky.test")).toBe(false);
    const envs = (view.forward.get("request:r1") ?? []).filter((e) => e.type === "usesEnvironment");
    expect(envs.map((e) => e.to).sort()).toEqual(["environment:e1", "environment:e2"]);
    expect(envs[0]?.origin).toBe("derived");
  });

  it("never stores credentials from URLs", () => {
    const { facts } = build();
    const text = JSON.stringify(facts);
    expect(text).not.toContain("pw@");
    expect(text).not.toContain("token=abc");
    expect(text).not.toContain("secret-path");
    expect(text).toContain("search.test:8443");
  });

  it("matches requests to specification operations by method, path and server", () => {
    const { view } = build();
    const implemented = (id: string) =>
      (view.forward.get(id) ?? []).filter((e) => e.type === "implements").map((e) => e.to);
    expect(implemented("request:r1")).toContain("operation:s1:GET /invoices");
    expect(implemented("request:r2")).toEqual(["operation:s1:GET /invoices/{invoiceId}"]);
    // Different method, and a host the specification does not declare.
    expect(implemented("request:r3")).toEqual([]);
  });

  it("builds the structural and declared relationships", () => {
    const { view } = build();
    const edge = (from: string, type: string) =>
      (view.forward.get(from) ?? []).filter((e) => e.type === type);
    expect(edge("collection:c1", "contains").map((e) => e.to)).toEqual(["folder:f1"]);
    expect(edge("folder:f1", "contains").map((e) => e.to)).toEqual(["request:r1", "request:r2"]);
    expect(edge("collection:c1", "syncedFrom")[0]?.to).toBe("specification:s1");
    expect(edge("mock:m1", "mocks")[0]?.to).toBe("collection:c1");
    expect(edge("monitor:mo1", "monitors")[0]?.to).toBe("collection:c1");
    expect(edge("catalog:k1", "publishes")[0]?.to).toBe("collection:c1");
    expect(edge("specification:s1", "servedBy")[0]?.to).toBe("service:api.pay.test");
    expect(edge("webhook:h1", "calls")[0]?.to).toBe("service:hooks.chat.test");
    expect(edge("captureSession:cap1", "observed")[0]).toMatchObject({
      origin: "telemetry",
      props: { requests: 12 },
    });
  });

  it("tags every edge with the source that produced it", () => {
    const { facts } = build();
    for (const f of facts) for (const e of f.edges) expect(e.sourceId).toBe(f.id);
  });
});

describe("queries", () => {
  it("answers what is affected when a service changes", () => {
    const { view } = build();
    const result = traverse(view, "service:api.pay.test", { direction: "dependents", depth: 5, limit: 100 })!;
    const reached = result.nodes.map((n) => n.node.id);
    expect(reached).toEqual(
      expect.arrayContaining([
        "request:r1",
        "request:r2",
        "folder:f1",
        "collection:c1",
        "monitor:mo1",
        "mock:m1",
        "catalog:k1",
        "specification:s1",
        "captureSession:cap1",
      ]),
    );
    expect(reached).not.toContain("request:r3");
    expect(result.summary.request).toBe(2);
    // Each node says which relationship first reached it.
    expect(result.nodes.find((n) => n.node.id === "request:r1")?.via).toMatchObject({
      type: "calls",
      origin: "derived",
    });
    expect(result.nodes.find((n) => n.node.id === "monitor:mo1")?.depth).toBeGreaterThan(
      result.nodes.find((n) => n.node.id === "collection:c1")!.depth,
    );
  });

  it("answers what a monitor relies on", () => {
    const { view } = build();
    const result = traverse(view, "monitor:mo1", { direction: "dependencies", depth: 8, limit: 100 })!;
    const reached = result.nodes.map((n) => n.node.id);
    expect(reached).toEqual(expect.arrayContaining(["collection:c1", "request:r1", "service:api.pay.test"]));
    expect(reached).not.toContain("catalog:k1");
  });

  it("honours depth, edge type and origin filters", () => {
    const { view } = build();
    const shallow = traverse(view, "monitor:mo1", { direction: "dependencies", depth: 1, limit: 100 })!;
    expect(shallow.nodes.map((n) => n.node.id)).toEqual(["collection:c1"]);
    const calls = traverse(view, "service:api.pay.test", {
      direction: "dependents",
      depth: 5,
      types: ["calls"],
      limit: 100,
    })!;
    expect(calls.nodes.map((n) => n.node.kind).sort()).toEqual(["request", "request", "webhook"].slice(0, 2));
    const observed = traverse(view, "service:api.pay.test", {
      direction: "dependents",
      depth: 5,
      origins: ["telemetry"],
      limit: 100,
    })!;
    expect(observed.nodes.map((n) => n.node.id)).toEqual(["captureSession:cap1"]);
  });

  it("flags truncation when the result limit is hit", () => {
    const { view } = build();
    const result = traverse(view, "service:api.pay.test", { direction: "dependents", depth: 5, limit: 2 })!;
    expect(result.truncated).toBe(true);
    expect(result.nodes.length).toBeLessThanOrEqual(3);
  });

  it("finds the shortest chain, in either direction", () => {
    const { view } = build();
    const down = shortestPath(view, "monitor:mo1", "service:api.pay.test", 8)!;
    expect(down.reversed).toBe(false);
    expect(down.nodes.map((n) => n.id)[0]).toBe("monitor:mo1");
    expect(down.nodes.at(-1)?.id).toBe("service:api.pay.test");
    expect(down.edges).toHaveLength(down.nodes.length - 1);
    const up = shortestPath(view, "service:api.pay.test", "monitor:mo1", 8)!;
    expect(up.reversed).toBe(true);
    expect(up.nodes[0]?.id).toBe("service:api.pay.test");
    expect(shortestPath(view, "request:r3", "monitor:mo1", 8)).toBeNull();
  });

  it("searches by name with exact matches first", () => {
    const { view } = build();
    expect(searchNodes(view, "billing", undefined)[0]?.node.label.toLowerCase()).toContain("billing");
    expect(searchNodes(view, "pay.test", "service").map((h) => h.node.id)).toContain("service:api.pay.test");
    expect(searchNodes(view, "api.pay.test", undefined)[0]?.node.id).toBe("service:api.pay.test");
  });

  it("drops edges whose far end is missing instead of inventing nodes", () => {
    const { facts } = build();
    const without = facts.filter((f) => f.kind !== "environment");
    const view = buildView(
      without.flatMap((f) => f.nodes),
      without.flatMap((f) => f.edges),
    );
    expect(view.edges.some((e) => e.type === "usesEnvironment")).toBe(false);
    expect(view.nodes.has("environment:e1")).toBe(false);
  });
});

// ------------------------------------------------------------------ stored graph

let owner: UserRow, editor: UserRow, outsider: UserRow, both: UserRow;
let ws: string, other: string;
let collectionId: string, requestId: string, specId: string;

const openapi = (paths: string[]) =>
  JSON.stringify({
    openapi: "3.0.0",
    info: { title: "T", version: "1" },
    servers: [{ url: "https://api.graph.test/v1" }],
    paths: Object.fromEntries(
      paths.map((p) => [p, { get: { responses: { "200": { description: "ok" } } } }]),
    ),
  });
function saveSpec(content: string, revision = 1) {
  const db = getDb();
  const existing = db
    .select()
    .from(schema.specifications)
    .all()
    .find((s) => s.id === specId);
  if (!existing)
    db.insert(schema.specifications)
      .values({
        id: specId,
        workspaceId: ws,
        name: "Graph API",
        format: "openapi",
        revision,
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
  else getSqlite().prepare("UPDATE specifications SET revision = ? WHERE id = ?").run(revision, specId);
  db.insert(schema.specificationVersions)
    .values({
      specificationId: specId,
      version: revision,
      entrypoint: "openapi.json",
      files: [{ path: "openapi.json", content }],
      createdAt: 1,
    })
    .run();
}

beforeAll(async () => {
  owner = await users.createUser({ username: "owner", password: "password123" });
  editor = await users.createUser({ username: "editor", password: "password123" });
  outsider = await users.createUser({ username: "outsider", password: "password123" });
  both = await users.createUser({ username: "both", password: "password123" });
  for (const user of [owner, editor, outsider, both]) tokens[user.id] = users.createToken(user.id, "t").token;
  ws = withCaller(caller(owner), () => repo.createWorkspace("Graph")).id;
  other = withCaller(caller(owner), () => repo.createWorkspace("Other")).id;
  withCaller(caller(owner), () => {
    setMember(ws, editor.username, "editor");
    setMember(ws, both.username, "viewer");
    setMember(other, both.username, "viewer");
  });
  specId = "spec-graph";
  withCaller(caller(owner), () => {
    const collection = repo.createFolder(ws, null, { name: "Graph collection" });
    collectionId = collection.id;
    repo.createEnvironment(ws, "Prod", [
      { key: "base", value: "https://api.graph.test/v1", type: "default", enabled: true },
    ]);
    requestId = repo.createRequest(ws, collection.id, {
      name: "List things",
      method: "GET",
      url: "{{base}}/things",
    }).id;
    const otherCollection = repo.createFolder(other, null, { name: "Elsewhere" });
    repo.createRequest(other, otherCollection.id, {
      name: "Also hits it",
      method: "GET",
      url: "https://api.graph.test/v1/x",
    });
  });
  saveSpec(openapi(["/things"]));
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const as = <T>(user: UserRow, fn: () => T) => withCaller(caller(user), fn);

describe("indexing a workspace", () => {
  it("indexes every source and answers queries from the stored graph", () => {
    const result = as(editor, () => graph.refreshGraph(ws));
    expect(result.added).toBe(3);
    expect(result.errors).toBe(0);
    const traversal = as(owner, () =>
      graph.traverseGraph({
        workspaceId: ws,
        node: "service:api.graph.test",
        direction: "dependents",
        depth: 5,
      }),
    );
    const ids = traversal.nodes.map((n) => n.node.id);
    expect(ids).toContain(`request:${requestId}`);
    expect(ids).toContain(`collection:${collectionId}`);
    expect(ids).toContain(`specification:${specId}`);
    expect(traversal.edges.every((e) => e.sourceId.length > 0 && !!e.origin)).toBe(true);
    const implemented = as(owner, () =>
      graph.traverseGraph({
        workspaceId: ws,
        node: `request:${requestId}`,
        direction: "dependencies",
        depth: 1,
      }),
    );
    expect(implemented.nodes.map((n) => n.node.id)).toContain(`operation:${specId}:GET /things`);
  });

  it("rewrites only the sources that changed", () => {
    const again = as(owner, () => graph.refreshGraph(ws));
    expect(again).toMatchObject({ added: 0, updated: 0, removed: 0, errors: 0 });
    expect(again.unchanged).toBe(again.sources);
    // Something the graph does not look at does not cause a rewrite.
    getSqlite().prepare("UPDATE requests SET description = ? WHERE id = ?").run("notes", requestId);
    const edited = as(owner, () => graph.refreshGraph(ws));
    expect(edited).toMatchObject({ added: 0, updated: 0, removed: 0 });
    getSqlite()
      .prepare("UPDATE requests SET url = ? WHERE id = ?")
      .run("https://moved.graph.test/things", requestId);
    const moved = as(owner, () => graph.refreshGraph(ws));
    expect(moved.updated).toBe(1);
    const impact = as(owner, () =>
      graph.traverseGraph({
        workspaceId: ws,
        node: "service:moved.graph.test",
        direction: "dependents",
        depth: 3,
      }),
    );
    expect(impact.nodes.map((n) => n.node.id)).toContain(`request:${requestId}`);
    getSqlite().prepare("UPDATE requests SET url = ? WHERE id = ?").run("{{base}}/things", requestId);
    as(owner, () => graph.refreshGraph(ws));
  });

  it("removes a source and its facts when the thing it described is deleted", () => {
    const before = as(owner, () => graph.listSources(ws)).map((s) => s.id);
    expect(before).toContain(`specification:${specId}`);
    getSqlite().prepare("DELETE FROM specifications WHERE id = ?").run(specId);
    const result = as(owner, () => graph.refreshGraph(ws));
    expect(result.removed).toBe(1);
    expect(
      getSqlite()
        .prepare("SELECT COUNT(*) AS n FROM graph_nodes WHERE source_id = ?")
        .get(`specification:${specId}`),
    ).toEqual({ n: 0 });
    expect(
      getSqlite()
        .prepare("SELECT COUNT(*) AS n FROM graph_edges WHERE source_id = ?")
        .get(`specification:${specId}`),
    ).toEqual({ n: 0 });
    const implemented = as(owner, () =>
      graph.traverseGraph({
        workspaceId: ws,
        node: `request:${requestId}`,
        direction: "dependencies",
        depth: 1,
      }),
    );
    expect(implemented.nodes.map((n) => n.node.id)).not.toContain(`operation:${specId}:GET /things`);
  });

  it("keeps the last good facts and reports an error when a specification becomes unreadable", () => {
    saveSpec(openapi(["/things"]), 1);
    as(owner, () => graph.refreshGraph(ws));
    saveSpec("{ not json", 2);
    const result = as(owner, () => graph.refreshGraph(ws));
    expect(result.errors).toBe(1);
    // The collection still knows which operation its request implements.
    expect(result.updated).toBe(0);
    const state = as(owner, () => graph.listSources(ws)).find((s) => s.id === `specification:${specId}`);
    expect(state).toMatchObject({ state: "error" });
    expect(state?.error).toBeTruthy();
    const kept = as(owner, () =>
      graph.searchGraph({ workspaceId: ws, query: "GET /things", kind: "operation" }),
    );
    expect(kept.nodes).toHaveLength(1);
    saveSpec(openapi(["/things", "/more"]), 3);
    expect(as(owner, () => graph.refreshGraph(ws))).toMatchObject({ errors: 0, updated: 1 });
    expect(
      as(owner, () => graph.listSources(ws)).find((s) => s.id === `specification:${specId}`)?.state,
    ).toBe("fresh");
  });

  it("reports a source as stale when it has not been checked for a long time", () => {
    getSqlite().prepare("UPDATE graph_sources SET checked_at = ? WHERE workspace_id = ?").run(1, ws);
    const rows = getDb()
      .select()
      .from(schema.graphSources)
      .where(eq(schema.graphSources.workspaceId, ws))
      .all();
    const fresh = rows.filter((r) => r.state === "fresh");
    expect(fresh.length).toBeGreaterThan(0);
    expect(fresh.every((r) => graph.sourceState(r) === "stale")).toBe(true);
    // Reading re-checks the workspace, which brings everything back to fresh.
    const listed = as(owner, () => graph.listSources(ws));
    expect(listed.filter((s) => s.state === "stale")).toEqual([]);
  });
});

describe("telemetry sources", () => {
  let session: string;
  it("contribute nothing until someone connects them", () => {
    session = as(owner, () =>
      capture.createSession(ws, {
        name: "Traffic",
        hosts: [],
        allowHttps: true,
        captureCookies: false,
      } as never),
    ).id;
    getSqlite()
      .prepare(
        "INSERT INTO capture_entries (id, session_id, workspace_id, started_at, method, url, request_headers, request_body, response_body) VALUES (?, ?, ?, ?, 'GET', ?, '[]', '{}', '{}')",
      )
      .run("ce1", session, ws, 100, "https://seen.graph.test/a?token=zzz");
    as(owner, () => graph.refreshGraph(ws));
    const listed = as(owner, () => graph.listSources(ws)).find((s) => s.id === `captureSession:${session}`);
    expect(listed).toMatchObject({ telemetry: true, connected: false, state: "revoked" });
    expect(as(owner, () => graph.searchGraph({ workspaceId: ws, query: "seen.graph.test" })).nodes).toEqual(
      [],
    );
  });

  it("add observed edges once connected, with their provenance", () => {
    expect(() => as(editor, () => graph.setSourceConnected(ws, `captureSession:${session}`, true))).toThrow();
    const connected = as(owner, () => graph.setSourceConnected(ws, `captureSession:${session}`, true));
    expect(connected).toMatchObject({ connected: true, state: "fresh" });
    const found = as(owner, () =>
      graph.traverseGraph({
        workspaceId: ws,
        node: "service:seen.graph.test",
        direction: "dependents",
        depth: 2,
        origins: ["telemetry"],
      }),
    );
    expect(found.nodes.map((n) => n.node.id)).toEqual([`captureSession:${session}`]);
    expect(found.edges[0]).toMatchObject({
      origin: "telemetry",
      sourceId: `captureSession:${session}`,
      props: { requests: 1 },
    });
    expect(JSON.stringify(found)).not.toContain("zzz");
  });

  it("are removed again when disconnected", () => {
    const off = as(owner, () => graph.setSourceConnected(ws, `captureSession:${session}`, false));
    expect(off).toMatchObject({ connected: false, state: "revoked" });
    expect(as(owner, () => graph.searchGraph({ workspaceId: ws, query: "seen.graph.test" })).nodes).toEqual(
      [],
    );
    expect(
      getSqlite()
        .prepare("SELECT COUNT(*) AS n FROM graph_edges WHERE source_id = ?")
        .get(`captureSession:${session}`),
    ).toEqual({ n: 0 });
  });

  it("cannot be toggled for sources that are not telemetry", () => {
    expect(() => as(owner, () => graph.setSourceConnected(ws, `collection:${collectionId}`, false))).toThrow(
      /telemetry/,
    );
  });
});

describe("access", () => {
  it("hides a workspace's graph from people who cannot read it", () => {
    expect(() => as(outsider, () => graph.searchGraph({ workspaceId: ws, query: "" }))).toThrow(/not found/i);
    expect(() => as(outsider, () => graph.listSources(ws))).toThrow(/not found/i);
  });

  it("lets viewers read but not refresh or reconfigure", () => {
    expect(
      as(both, () => graph.searchGraph({ workspaceId: ws, query: "things" })).nodes.length,
    ).toBeGreaterThan(0);
    expect(() => as(both, () => graph.refreshGraph(ws))).toThrow(/role/i);
    expect(() => as(both, () => graph.setSourceConnected(ws, `captureSession:x`, true))).toThrow();
  });

  it("filters shared services down to workspaces the caller can read", () => {
    as(owner, () => graph.refreshGraph(other));
    const dependents = (user: UserRow) =>
      as(user, () =>
        graph.traverseGraph({
          workspaceId: ws,
          node: "service:api.graph.test",
          direction: "dependents",
          depth: 3,
          types: ["calls"],
        }),
      ).nodes.map((n) => n.node.label);
    expect(dependents(owner).some((l) => l.includes("Also hits it"))).toBe(true);
    // The editor belongs to one workspace only: the other workspace's request is not theirs to see.
    expect(dependents(editor).some((l) => l.includes("Also hits it"))).toBe(false);
    expect(dependents(editor).some((l) => l.includes("List things"))).toBe(true);
    // Someone who can read both sees both.
    const seen = dependents(both);
    expect(seen.some((l) => l.includes("Also hits it"))).toBe(true);
    expect(seen.some((l) => l.includes("List things"))).toBe(true);
  });

  it("stops showing a workspace's edges the moment access is revoked", () => {
    withCaller(caller(owner), () => setMember(other, both.username, null as never));
    const labels = as(both, () =>
      graph.traverseGraph({
        workspaceId: ws,
        node: "service:api.graph.test",
        direction: "dependents",
        depth: 3,
        types: ["calls"],
      }),
    ).nodes.map((n) => n.node.label);
    expect(labels.some((l) => l.includes("Also hits it"))).toBe(false);
  });
});

describe("routes", () => {
  const get = (route: { GET: (req: Request) => Promise<Response> }, url: string, user = owner) =>
    route.GET(
      new Request(`http://localhost${url}`, { headers: { authorization: `Bearer ${tokens[user.id]}` } }),
    );

  it("serve search and traversal over HTTP", async () => {
    const s = await get(searchRoute, `/api/graph/search?workspaceId=${ws}&query=things`);
    expect(s.status).toBe(200);
    expect((await s.json()).nodes.length).toBeGreaterThan(0);
    const t = await get(
      traverseRoute,
      `/api/graph/traverse?workspaceId=${ws}&node=service:api.graph.test&direction=dependents&depth=2&types=calls,implements`,
    );
    expect(t.status).toBe(200);
    expect(
      (await t.json()).edges.every((e: { type: string }) => ["calls", "implements"].includes(e.type)),
    ).toBe(true);
  });

  it("reject bad input and unknown nodes", async () => {
    expect((await get(traverseRoute, `/api/graph/traverse?workspaceId=${ws}&node=nope:1`)).status).toBe(404);
    expect((await get(traverseRoute, `/api/graph/traverse?workspaceId=${ws}&node=a&depth=99`)).status).toBe(
      400,
    );
    expect((await get(searchRoute, `/api/graph/search?workspaceId=${ws}&kind=bogus`)).status).toBe(400);
    expect((await get(sourcesRoute, `/api/graph/sources?workspaceId=${ws}`, outsider)).status).toBe(404);
  });
});
