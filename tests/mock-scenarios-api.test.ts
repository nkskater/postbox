import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-mock-scenarios-"));
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

function setup(scenarios: unknown[] = []) {
  const workspace = repo.createWorkspace("Scenarios");
  const folder = repo.createFolder(workspace.id, null, { name: "API" });
  repo.createRequest(workspace.id, folder.id, {
    name: "Get user",
    method: "GET",
    url: "https://example.test/users/:id",
    examples: [
      {
        id: "ok",
        name: "Success",
        status: 200,
        statusText: "OK",
        headers: [{ key: "Content-Type", value: "application/json", enabled: true }],
        body: '{"name":"Alice"}',
        createdAt: 1,
      },
    ],
  });
  const mock = mocks.createMock({
    workspaceId: workspace.id,
    folderId: folder.id,
    name: "Users",
    scenarios: scenarios as never,
  });
  return { workspace, folder, mock };
}
const get = (
  mock: { id: string; key?: string },
  headers: Record<string, string> = {},
  p = "/users/42",
  method = "GET",
) =>
  mocks.serveMock(
    new Request(`http://localhost/mock/${mock.id}${p}`, {
      method,
      headers: { "x-postbox-mock-key": mock.key ?? "", ...headers },
    }),
    mock.id,
  );
const codes = async (mock: { id: string; key?: string }, n: number, headers: Record<string, string> = {}) => {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((await get(mock, headers)).status);
  return out;
};

describe("mock failure scenarios", () => {
  it("fails the first requests of a session with a labelled simulated response, then serves the example", async () => {
    const { mock } = setup([{ id: "flaky", name: "Flaky start", kind: "failFirst", count: 2, status: 503 }]);
    const first = await get(mock);
    expect(first.status).toBe(503);
    expect(first.headers.get("x-postbox-mock-scenario")).toBe("flaky");
    expect(first.headers.get("x-postbox-mock-session")).toBe("default");
    expect(first.headers.get("content-type")).toContain("application/json");
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(await first.json()).toEqual({ error: "Simulated failure", scenario: "Flaky start", status: 503 });
    expect((await get(mock)).status).toBe(503);
    const ok = await get(mock);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ name: "Alice" });
    expect(ok.headers.get("x-postbox-mock-example")).toBe("ok");
    // The request log records the simulated status and no example.
    const logs = mocks.listMockLogs(mock.id);
    expect(logs.map((l) => [l.status, l.exampleId]).reverse()).toEqual([
      [503, null],
      [503, null],
      [200, "ok"],
    ]);
  });

  it("keeps sessions independent, validates session names and resets on demand", async () => {
    const { mock } = setup([{ id: "f", name: "Flaky", kind: "failFirst", count: 1, status: 500 }]);
    expect(await codes(mock, 2, { "x-mock-session": "alice" })).toEqual([500, 200]);
    expect(await codes(mock, 2, { "x-mock-session": "bob" })).toEqual([500, 200]);
    expect(await codes(mock, 1, { "x-mock-session": "alice" })).toEqual([200]);
    expect((await get(mock, { "x-mock-session": "bad session!" })).status).toBe(400);

    expect(mocks.resetMockState(mock.id, "alice")).toEqual({ ok: true, cleared: 1 });
    expect(await codes(mock, 2, { "x-mock-session": "alice" })).toEqual([500, 200]);
    expect(await codes(mock, 1, { "x-mock-session": "bob" })).toEqual([200]);
    expect(mocks.resetMockState(mock.id).cleared).toBe(2);
    expect(() => mocks.resetMockState(mock.id, "no good")).toThrow(/Invalid session/);
    expect(() => mocks.resetMockState("missing-mock")).toThrow();
    expect(await codes(mock, 2, { "x-mock-session": "bob" })).toEqual([500, 200]);
  });

  it("counts concurrent requests of one session exactly", async () => {
    const { mock } = setup([{ id: "e", name: "Every other", kind: "failEvery", every: 2, status: 500 }]);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => get(mock, { "x-mock-session": "ci" })),
    );
    expect(results.filter((r) => r.status === 500)).toHaveLength(10);
    expect(results.filter((r) => r.status === 200)).toHaveLength(10);
  });

  it("limits request rates with standard headers and recovers after a reset", async () => {
    const { mock } = setup([{ id: "rl", name: "Limit", kind: "rateLimit", limit: 2, windowSeconds: 60 }]);
    const a = await get(mock);
    expect([a.status, a.headers.get("x-ratelimit-limit"), a.headers.get("x-ratelimit-remaining")]).toEqual([
      200,
      "2",
      "1",
    ]);
    expect((await get(mock)).headers.get("x-ratelimit-remaining")).toBe("0");
    const blocked = await get(mock);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(Number(blocked.headers.get("retry-after"))).toBeLessThanOrEqual(60);
    mocks.resetMockState(mock.id);
    expect((await get(mock)).status).toBe(200);
  });

  it("walks a status sequence, including a normal response in the middle", async () => {
    const { mock } = setup([
      { id: "seq", name: "Seq", kind: "sequence", statuses: [500, 0, 429], repeat: false },
    ]);
    expect(await codes(mock, 5)).toEqual([500, 200, 429, 429, 429]);
  });

  it("adds latency, and counts only requests that match its method and path", async () => {
    const { mock } = setup([
      { id: "slow", name: "Slow", kind: "delay", ms: 120, match: { method: "GET", path: "/users/:id" } },
      { id: "post", name: "Posts fail", kind: "error", status: 500, match: { method: "POST" } },
    ]);
    const started = Date.now();
    expect((await get(mock)).status).toBe(200);
    expect(Date.now() - started).toBeGreaterThanOrEqual(110);
    expect((await get(mock, {}, "/users/42", "POST")).status).toBe(500);
    // A path the delay does not cover is fast.
    const fast = Date.now();
    await get(mock, {}, "/other");
    expect(Date.now() - fast).toBeLessThan(100);
  });

  it("simulates failures even where no example matches, and honours HEAD", async () => {
    const { mock } = setup([
      {
        id: "down",
        name: "Down",
        kind: "error",
        status: 503,
        body: "maintenance",
        contentType: "text/plain",
      },
    ]);
    const unmatched = await get(mock, {}, "/nothing/here");
    expect(unmatched.status).toBe(503);
    expect(await unmatched.text()).toBe("maintenance");
    expect(unmatched.headers.get("content-type")).toBe("text/plain");
    const head = await get(mock, {}, "/users/1", "HEAD");
    expect(head.status).toBe(503);
    expect(await head.text()).toBe("");
  });

  it("masks workspace secrets that appear in a simulated body", async () => {
    const { mock, workspace } = setup();
    repo.replaceVariables(workspace.id, "global", null, [
      { key: "k", value: "super-secret-value-77", type: "secret", enabled: true },
    ]);
    mocks.updateMock(mock.id, {
      scenarios: [
        { id: "s", name: "Leaky", kind: "error", status: 500, body: "token=super-secret-value-77" },
      ] as never,
    });
    const text = await (await get(mock)).text();
    expect(text).not.toContain("super-secret-value-77");
    expect(JSON.stringify(mocks.getMock(mock.id))).not.toContain("super-secret-value-77");
    expect(JSON.stringify(mocks.exportMock(mock.id))).not.toContain("super-secret-value-77");
  });

  it("validates scenarios on update, restarts counters when they change, and keeps them in exports and backups", async () => {
    const { mock } = setup([{ id: "f", name: "Flaky", kind: "failFirst", count: 1, status: 500 }]);
    expect(await codes(mock, 2)).toEqual([500, 200]);
    expect(() =>
      mocks.updateMock(mock.id, { scenarios: [{ id: "x", name: "n", kind: "error", status: 200 }] as never }),
    ).toThrow();
    expect(await codes(mock, 1)).toEqual([200]); // a rejected update changes nothing
    const next = [{ id: "f", name: "Flaky", kind: "failFirst", count: 1, status: 502 }] as never;
    expect(mocks.updateMock(mock.id, { scenarios: next }).scenarios).toHaveLength(1);
    expect(await codes(mock, 2)).toEqual([502, 200]); // counters restarted
    expect(mocks.updateMock(mock.id, { name: "Renamed" }).scenarios).toHaveLength(1);
    expect(await codes(mock, 1)).toEqual([200]); // unrelated edits keep counters
    expect(mocks.exportMock(mock.id).scenarios).toHaveLength(1);

    const { createBackup } = await import("@/server/backup");
    const { getDb } = await import("@/server/db");
    const backup = createBackup(getDb(), { includeSecrets: true });
    const saved = backup.tables.mockServers.find((m) => m.id === mock.id)!;
    // Stored as validated (defaults filled in), identical to what the API returns.
    expect(saved.scenarios).toEqual(mocks.getMock(mock.id).scenarios);
    expect(saved.scenarios).toMatchObject(next as never);
  });

  it("changes only the fields a partial update names", () => {
    const { mock } = setup([{ id: "f", name: "Flaky", kind: "failFirst", count: 1, status: 500 }]);
    mocks.updateMock(mock.id, {
      enabled: false,
      public: true,
      matchQuery: false,
      delayMs: 40,
      status: 202,
      headers: [{ key: "X-Custom", value: "1", enabled: true }],
    });
    const renamed = mocks.updateMock(mock.id, { name: "Renamed" });
    expect(renamed).toMatchObject({
      name: "Renamed",
      enabled: false,
      public: true,
      matchQuery: false,
      matchBody: true,
      delayMs: 40,
      status: 202,
    });
    expect(renamed.headers).toHaveLength(1);
    expect(renamed.scenarios).toHaveLength(1);
  });

  it("exposes a reset route", async () => {
    const { mock } = setup([{ id: "f", name: "Flaky", kind: "failFirst", count: 1, status: 500 }]);
    await codes(mock, 2, { "x-mock-session": "ci" });
    const route = await import("@/app/api/mocks/[id]/reset/route");
    const call = (body: object) =>
      route.POST(
        new Request(`http://localhost/api/mocks/${mock.id}/reset`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        {
          params: Promise.resolve({ id: mock.id }),
        },
      );
    expect(await (await call({ session: "ci" })).json()).toEqual({ ok: true, cleared: 1 });
    expect((await call({ session: "bad name" })).status).toBe(400);
    expect(await codes(mock, 1, { "x-mock-session": "ci" })).toEqual([500]);
  });
});
