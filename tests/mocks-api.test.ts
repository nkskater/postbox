import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-mocks-"));
process.env.DATABASE_PATH = path.join(directory, "test.db");
let repo: typeof import("@/server/repo"), mocks: typeof import("@/server/mocks");
beforeAll(async () => {
  repo = await import("@/server/repo");
  mocks = await import("@/server/mocks");
});
afterAll(async () => {
  (await import("@/server/db")).getSqlite().close();
  fs.rmSync(directory, { recursive: true, force: true });
});
function setup() {
  const workspace = repo.createWorkspace("Mocks"),
    folder = repo.createFolder(workspace.id, null, { name: "Mock collection" });
  const request = repo.createRequest(workspace.id, folder.id, {
    name: "Create user",
    method: "POST",
    url: "https://example.test/users/:id?page=1",
    body: { mode: "raw", language: "json", raw: '{"a":1,"b":2}' },
    examples: [
      {
        id: "ok",
        name: "Success",
        status: 201,
        statusText: "Created",
        headers: [{ key: "Content-Type", value: "application/json", enabled: true }],
        body: '{"name":"Alice"}',
        createdAt: 1,
      },
      {
        id: "missing",
        name: "Missing",
        status: 404,
        statusText: "Not Found",
        headers: [],
        body: "missing",
        createdAt: 2,
      },
    ],
  });
  const mock = mocks.createMock({ workspaceId: workspace.id, folderId: folder.id, name: "User mock" });
  return { workspace, folder, request, mock };
}
const invoke = (mock: { id: string; key?: string }, extra: RequestInit = {}, suffix = "/users/42?page=1") =>
  mocks.serveMock(
    new Request(`http://localhost/mock/${mock.id}${suffix}`, {
      method: "POST",
      body: '{"b":2,"a":1}',
      ...extra,
      headers: { "x-postbox-mock-key": mock.key ?? "", ...extra.headers },
    }),
    mock.id,
  );
describe("example-backed mock endpoints", () => {
  it("creates private endpoints, matches JSON/query/path and selects examples deterministically", async () => {
    const { mock } = setup();
    expect(mock.public).toBe(false);
    expect(JSON.stringify(mocks.getMock(mock.id))).not.toContain(mock.key);
    expect((await invoke({ ...mock, key: "wrong" })).status).toBe(401);
    const response = await invoke(mock);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ name: "Alice" });
    expect((await invoke(mock, { headers: { "x-mock-response-name": "Missing" } })).status).toBe(404);
    expect(await (await invoke(mock, { headers: { "x-mock-response-id": "missing" } })).text()).toBe(
      "missing",
    );
    expect((await invoke(mock, {}, "/users/42?page=2")).status).toBe(404);
    expect((await invoke(mock, { body: '{"a":9}' })).status).toBe(404);
    expect((await invoke(mock, { method: "PUT" })).status).toBe(404);
  });
  it("pins snapshots until explicit refresh and applies status, headers and delay", async () => {
    const { mock, request } = setup();
    repo.updateRequest(request.id, {
      examples: [
        {
          id: "new",
          name: "New",
          status: 202,
          statusText: "Accepted",
          headers: [],
          body: "new body",
          createdAt: 1,
        },
      ],
    });
    expect((await invoke(mock)).status).toBe(201);
    expect(mocks.refreshMock(mock.id).revision).toBe(2);
    expect(await (await invoke(mock)).text()).toBe("new body");
    mocks.updateMock(mock.id, {
      status: 203,
      delayMs: 30,
      headers: [
        { key: "X-Example", value: "configured", enabled: true },
        { key: "Set-Cookie", value: "session=private", enabled: true },
      ],
    });
    const start = Date.now(),
      response = await invoke(mock);
    expect(Date.now() - start).toBeGreaterThanOrEqual(25);
    expect(response.status).toBe(203);
    expect(response.headers.get("X-Example")).toBe("configured");
    expect(response.headers.has("Set-Cookie")).toBe(false);
    expect(response.headers.get("Content-Security-Policy")).toContain("sandbox");
  });
  it("rotates credentials, requires explicit sharing, and disables or deletes endpoints", async () => {
    const { mock } = setup();
    const rotated = mocks.rotateMockKey(mock.id);
    expect((await invoke(mock)).status).toBe(401);
    expect((await invoke({ ...mock, ...rotated })).status).toBe(201);
    mocks.updateMock(mock.id, { public: true });
    expect((await invoke({ ...mock, key: "" })).status).toBe(201);
    mocks.updateMock(mock.id, { public: false });
    expect((await invoke({ ...mock, key: "" })).status).toBe(401);
    mocks.updateMock(mock.id, { enabled: false });
    expect((await invoke({ ...mock, ...rotated })).status).toBe(404);
    mocks.deleteMock(mock.id);
    expect((await invoke(mock)).status).toBe(404);
  });
  it("retains bounded template-only metadata and never raw incoming secrets", async () => {
    const { mock } = setup();
    for (let i = 0; i < 105; i++) await invoke(mock, {}, `/users/private-incoming-${i}?page=1`);
    await invoke(mock, {}, "/unknown/private-query?token=incoming-secret");
    const logs = mocks.listMockLogs(mock.id);
    expect(logs).toHaveLength(100);
    expect(JSON.stringify(logs)).not.toMatch(/private-incoming|private-query|incoming-secret|token=/);
    expect(logs.some((log) => log.path === "[unmatched]")).toBe(true);
    expect(logs.some((log) => log.path === "/users/:id")).toBe(true);
    mocks.clearMockLogs(mock.id);
    expect(mocks.listMockLogs(mock.id)).toEqual([]);
  });
  it("sanitizes credentials from saved examples and export, including newly marked secrets", async () => {
    const { workspace, folder, request, mock } = setup();
    repo.replaceVariables(workspace.id, "global", null, [
      { key: "private", value: "workspace-secret-value", type: "secret", enabled: true },
    ]);
    repo.updateRequest(request.id, {
      auth: { type: "bearer", bearer: { token: "literal-auth-secret" } },
      examples: [
        {
          id: "private",
          name: "Private response",
          status: 200,
          statusText: "OK",
          headers: [],
          body: '{"message":"workspace-secret-value literal-auth-secret"}',
          createdAt: 1,
        },
      ],
    });
    mocks.refreshMock(mock.id);
    const exported = JSON.stringify(mocks.exportMock(mock.id));
    expect(exported).not.toContain("workspace-secret-value");
    expect(exported).not.toContain("literal-auth-secret");
    expect(exported).not.toContain(mock.key);
    expect(exported).not.toContain("keyHash");
    expect(exported).not.toContain("preRequestScript");
    expect(JSON.stringify(mocks.getMock(mock.id))).not.toContain("literal-auth-secret");
    const response = await invoke(mock);
    expect(await response.text()).not.toContain("workspace-secret-value");
    expect(mocks.listMocks(workspace.id)[0].folderId).toBe(folder.id);
  });
  it("rejects oversized input and malformed paths, and supports empty responses", async () => {
    const { mock } = setup();
    expect((await invoke(mock, { body: "x".repeat(1024 * 1024 + 1) })).status).toBe(413);
    expect((await invoke(mock, {}, "/users/%ZZ?page=1")).status).toBe(400);
    mocks.updateMock(mock.id, { status: 204 });
    const noContent = await invoke(mock);
    expect(noContent.status).toBe(204);
    expect(await noContent.text()).toBe("");
    expect(() =>
      mocks.updateMock(mock.id, { headers: [{ key: "X-Bad", value: "line\r\ninjected", enabled: true }] }),
    ).toThrow(/Invalid/);
  });
  it("round-trips mock snapshots in application backups while safe backups revoke sharing and omit logs", async () => {
    const { mock } = setup();
    await invoke(mock);
    const { getDb, openDatabase } = await import("@/server/db"),
      backup = await import("@/server/backup");
    const full = backup.createBackup(getDb(), { includeSecrets: true });
    const fresh = openDatabase(path.join(directory, "restore.db"));
    try {
      const result = backup.restoreBackup(fresh.db, fresh.sqlite, JSON.parse(JSON.stringify(full)));
      expect(result.mockServers).toBeGreaterThan(0);
      const restored = fresh.db
        .select()
        .from((await import("@/server/db")).schema.mockServers)
        .all()
        .find((row) => row.id === mock.id)!;
      expect(restored.routes).toEqual(mocks.getMock(mock.id).routes);
      expect(restored.keyHash).toMatch(/^[a-f0-9]{64}$/);
      const safe = backup.createBackup(getDb(), { includeSecrets: false });
      const safeMock = safe.tables.mockServers.find((row) => row.id === mock.id)!;
      expect(safeMock.enabled).toBe(false);
      expect(safeMock.public).toBe(false);
      expect(safeMock.keyHash).not.toBe(restored.keyHash);
      expect("mockLogs" in full.tables).toBe(false);
    } finally {
      fresh.sqlite.close();
    }
  });
  it("redacts newly marked secrets without refreshing and returns exact binary response bytes", async () => {
    const { mock, workspace, request } = setup();
    repo.replaceVariables(workspace.id, "global", null, [
      { key: "late", value: "Alice", type: "secret", enabled: true },
    ]);
    expect(JSON.stringify(mocks.exportMock(mock.id))).not.toContain("Alice");
    expect(await (await invoke(mock)).text()).not.toContain("Alice");
    repo.updateRequest(request.id, {
      examples: [
        {
          id: "binary",
          name: "Binary",
          status: 200,
          statusText: "OK",
          headers: [],
          body: Buffer.from([0, 255, 128, 1]).toString("base64"),
          bodyEncoding: "base64",
          createdAt: 1,
        },
      ],
    });
    mocks.refreshMock(mock.id);
    expect([...new Uint8Array(await (await invoke(mock)).arrayBuffer())]).toEqual([0, 255, 128, 1]);
  });
  it("enforces workspace read/write access on management endpoints", async () => {
    const users = await import("@/server/users"),
      { withCaller } = await import("@/server/access-context"),
      { setMember } = await import("@/server/authorize");
    await users.createUser({ username: "admin", password: "password123", isAdmin: true });
    const owner = await users.createUser({ username: "owner", password: "password123" }),
      viewer = await users.createUser({ username: "viewer", password: "password123" }),
      outsider = await users.createUser({ username: "outsider", password: "password123" });
    const caller = { kind: "user" as const, user: owner, via: "token" as const };
    const workspace = withCaller(caller, () => repo.createWorkspace("Owned"));
    withCaller(caller, () => setMember(workspace.id, viewer.username, "viewer"));
    const folder = repo.createFolder(workspace.id, null);
    repo.createRequest(workspace.id, folder.id, {
      url: "https://example.test/",
      examples: [
        { id: "e", name: "E", status: 200, statusText: "OK", headers: [], body: "safe", createdAt: 1 },
      ],
    });
    const mock = withCaller(caller, () =>
      mocks.createMock({ workspaceId: workspace.id, folderId: folder.id, name: "Private" }),
    );
    const route = await import("@/app/api/mocks/[id]/route");
    const req = (user: typeof owner, method = "GET") =>
      new Request(`http://localhost/api/mocks/${mock.id}`, {
        method,
        headers: {
          authorization: `Bearer ${users.createToken(user.id, "test").token}`,
          "Content-Type": "application/json",
        },
        ...(method === "PATCH" ? { body: JSON.stringify({ public: true }) } : {}),
      });
    const context = { params: Promise.resolve({ id: mock.id }) };
    expect((await route.GET(req(viewer), context)).status).toBe(200);
    expect((await route.GET(req(outsider), context)).status).toBe(404);
    expect((await route.PATCH(req(viewer, "PATCH"), context)).status).toBe(403);
    expect((await invoke(mock, { method: "GET", body: undefined }, "/")).status).toBe(200);
    const foreign = repo.createWorkspace("Foreign");
    expect(() => mocks.createMock({ workspaceId: foreign.id, folderId: folder.id, name: "Bad" })).toThrow(
      /not found/i,
    );
  });
});
