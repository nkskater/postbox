import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-mock-handlers-"));
process.env.DATABASE_PATH = path.join(directory, "test.db");
let repo: typeof import("@/server/repo"), mocks: typeof import("@/server/mocks");
let backup: typeof import("@/server/backup"), dbm: typeof import("@/server/db");
beforeAll(async () => {
  repo = await import("@/server/repo");
  mocks = await import("@/server/mocks");
  backup = await import("@/server/backup");
  dbm = await import("@/server/db");
});
afterAll(() => {
  dbm.getSqlite().close();
  fs.rmSync(directory, { recursive: true, force: true });
});

const handler = (code: string, extra: Record<string, unknown> = {}) => ({
  id: `h${Math.random().toString(36).slice(2, 8)}`,
  name: "Handler",
  code,
  ...extra,
});

function setup(handlers: unknown[] = [], scenarios: unknown[] = [], withExample = true) {
  const workspace = repo.createWorkspace("Handlers");
  const folder = repo.createFolder(workspace.id, null, { name: "API" });
  if (withExample)
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
          headers: [
            { key: "Content-Type", value: "application/json", enabled: true },
            { key: "X-From-Example", value: "yes", enabled: true },
          ],
          body: '{"name":"Alice"}',
          createdAt: 1,
        },
      ],
    });
  else
    repo.createRequest(workspace.id, folder.id, {
      name: "Other",
      method: "GET",
      url: "https://example.test/other",
      examples: [{ id: "o", name: "o", status: 200, statusText: "OK", headers: [], body: "o", createdAt: 1 }],
    });
  const mock = mocks.createMock({
    workspaceId: workspace.id,
    folderId: folder.id,
    name: "Users",
    handlers: handlers as never,
    scenarios: scenarios as never,
  });
  return { workspace, folder, mock };
}
const call = (
  mock: { id: string; key?: string },
  p = "/users/42",
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
) =>
  mocks.serveMock(
    new Request(`http://localhost/mock/${mock.id}${p}`, {
      method: init.method ?? "GET",
      headers: { "x-postbox-mock-key": mock.key ?? "", ...init.headers },
      body: init.body,
    }),
    mock.id,
  );

describe("mock handlers", () => {
  it("computes a response from the request and per-session state", async () => {
    const { mock } = setup([
      handler(
        `const n = state.get("hits", 0) + 1; state.set("hits", n);
         return { status: n > 2 ? 429 : 200, json: { user: req.path.split("/").pop(), hits: n, who: req.headers["x-who"] ?? null } };`,
      ),
    ]);
    const seen = [];
    for (let i = 0; i < 3; i++) {
      const res = await call(mock, "/users/42", { headers: { "x-mock-session": "a", "x-who": "me" } });
      seen.push([res.status, await res.json()]);
    }
    expect(seen).toEqual([
      [200, { user: "42", hits: 1, who: "me" }],
      [200, { user: "42", hits: 2, who: "me" }],
      [429, { user: "42", hits: 3, who: "me" }],
    ]);
    const first = await call(mock, "/users/9", { headers: { "x-mock-session": "b" } });
    expect(await first.json()).toMatchObject({ hits: 1, user: "9" });
    expect(first.headers.get("content-type")).toContain("application/json");
    expect(first.headers.get("x-postbox-mock-handler")).toBeTruthy();
    expect(first.headers.get("x-postbox-mock-session")).toBe("b");
    expect(first.headers.get("x-from-example")).toBeNull(); // the handler supplied its own body
    expect(first.headers.get("cache-control")).toBe("no-store");
  });

  it("is reproducible: replaying the same sequence after a reset gives identical responses", async () => {
    const { mock } = setup([
      handler(
        `state.set("n", state.get("n", 0) + 1); return { json: { n: state.get("n"), r: Math.random(), t: new Date().toISOString(), c: ctx.count } };`,
      ),
    ]);
    const run = async () => {
      const out = [];
      for (let i = 0; i < 4; i++)
        out.push(await (await call(mock, "/x", { headers: { "x-mock-session": "r1" } })).json());
      return out;
    };
    const a = await run();
    expect(mocks.resetMockState(mock.id, "r1").cleared).toBe(1);
    expect(await run()).toEqual(a);
    expect(new Set(a.map((x) => x.r)).size).toBe(4);
  });

  it("falls back to the example when the handler returns nothing, and can tweak it", async () => {
    const { mock } = setup([
      handler(`if (req.headers["x-mode"] === "tweak") return { status: 202, headers: { "x-extra": "1" } };`),
    ]);
    const plain = await call(mock);
    expect(plain.status).toBe(200);
    expect(await plain.json()).toEqual({ name: "Alice" });
    expect(plain.headers.get("x-postbox-mock-example")).toBe("ok");
    const tweaked = await call(mock, "/users/1", { headers: { "x-mode": "tweak" } });
    expect(tweaked.status).toBe(202);
    expect(tweaked.headers.get("x-extra")).toBe("1");
    expect(tweaked.headers.get("x-from-example")).toBe("yes");
    expect(await tweaked.json()).toEqual({ name: "Alice" });
  });

  it("answers paths that no example matches, and can read the matched example", async () => {
    const { mock } = setup([
      handler(`return { status: 201, body: "created " + req.json.name, contentType: "text/plain" }`, {
        match: { method: "POST", path: "/things/:id" },
      }),
      handler(
        `return { json: { echoed: example.name, status: example.status, body: JSON.parse(example.body) } }`,
        {
          match: { method: "GET", path: "/users/:id" },
        },
      ),
    ]);
    const created = await call(mock, "/things/5", { method: "POST", body: '{"name":"bolt"}' });
    expect(created.status).toBe(201);
    expect(await created.text()).toBe("created bolt");
    expect(created.headers.get("content-type")).toBe("text/plain");
    expect(await (await call(mock)).json()).toEqual({
      echoed: "Success",
      status: 200,
      body: { name: "Alice" },
    });
    expect((await call(mock, "/nothing")).status).toBe(404);
    expect((await call(mock, "/things/5")).status).toBe(404); // method does not match the handler
  });

  it("returns a labelled 500 when a handler fails, without keeping its state changes", async () => {
    const { mock } = setup([
      handler(
        `state.set("a", 1); if (req.query.boom) throw new Error("exploded"); return { json: { a: state.get("a"), keys: state.keys() } }`,
      ),
    ]);
    const bad = await call(mock, "/x?boom=1");
    expect(bad.status).toBe(500);
    expect(bad.headers.get("x-postbox-mock-handler")).toBeTruthy();
    expect(await bad.json()).toMatchObject({
      error: "Mock handler failed",
      detail: expect.stringContaining("exploded"),
    });
    expect(mocks.inspectMockState(mock.id).sessions[0].state).toEqual({});
    const good = await call(mock, "/x");
    expect(await good.json()).toEqual({ a: 1, keys: ["a"] });
    expect(mocks.listMockLogs(mock.id).map((l) => l.status)).toEqual([200, 500]);
  });

  it("answers runaway handlers with an error and keeps serving", async () => {
    const { mock } = setup([handler(`if (req.query.loop) { while (true) {} } return { body: "fine" }`)]);
    const slow = await call(mock, "/x?loop=1");
    expect(slow.status).toBe(500);
    expect((await slow.json()).detail).toMatch(/ran longer/);
    expect(await (await call(mock, "/x")).text()).toBe("fine");
  }, 20000);

  it("runs after failure simulations, which still win", async () => {
    const { mock } = setup(
      [handler(`state.set("ran", state.get("ran", 0) + 1); return { json: { ran: state.get("ran") } }`)],
      [{ id: "f", name: "Flaky", kind: "failFirst", count: 1, status: 503 }],
    );
    expect((await call(mock)).status).toBe(503);
    expect(mocks.inspectMockState(mock.id).sessions[0]?.state ?? {}).toEqual({});
    expect(await (await call(mock)).json()).toEqual({ ran: 1 });
  });

  it("keeps credentials away from handlers and secrets out of responses", async () => {
    const { mock, workspace } = setup([
      handler(`return { json: { headers: Object.keys(req.headers).sort(), leak: "topsecret-value-12345" } }`),
    ]);
    repo.replaceVariables(workspace.id, "global", null, [
      { key: "token", value: "topsecret-value-12345", type: "secret", enabled: true },
    ]);
    const res = await call(mock, "/x", {
      headers: { authorization: "Bearer abc", cookie: "a=b", "x-ok": "1" },
    });
    const text = await res.text();
    expect(text).not.toContain("topsecret-value-12345");
    const headers = JSON.parse(text).headers as string[];
    expect(headers).toContain("x-ok");
    expect(headers).not.toContain("authorization");
    expect(headers).not.toContain("cookie");
    expect(headers).not.toContain("x-postbox-mock-key");
  });

  it("rejects invalid handler definitions and resets state when they change", async () => {
    const { mock, folder, workspace } = setup([handler(`state.set("n", 1)`)]);
    await call(mock);
    expect(mocks.inspectMockState(mock.id).sessions).toHaveLength(1);
    mocks.updateMock(mock.id, { handlers: [handler(`return { body: "v2" }`)] as never });
    expect(mocks.inspectMockState(mock.id).sessions).toHaveLength(0);
    expect(() =>
      mocks.createMock({
        workspaceId: workspace.id,
        folderId: folder.id,
        name: "bad",
        handlers: [handler("x".repeat(20000))] as never,
      }),
    ).toThrow();
    expect(mocks.getMock(mock.id).handlers).toHaveLength(1);
    expect(() =>
      mocks.updateMock(mock.id, {
        handlers: [handler("a"), { ...handler("b"), id: mocks.getMock(mock.id).handlers[0].id }] as never,
      }),
    ).not.toThrow();
  });

  it("tests handlers without storing anything", async () => {
    const { mock } = setup([
      handler(`state.set("n", state.get("n", 0) + 1); return { json: { n: state.get("n") } }`, {
        id: "saved",
      }),
    ]);
    const first = await mocks.testMockHandler(mock.id, { handlerId: "saved", state: { n: 4 }, count: 2 });
    expect(first).toMatchObject({ ok: true, result: { json: { n: 5 } }, state: { n: 5 } });
    const adhoc = await mocks.testMockHandler(mock.id, {
      code: `console.log("hello", req.path); return { json: example.name }`,
      request: { path: "/users/42" },
    });
    expect(adhoc).toMatchObject({ ok: true, logs: ["hello /users/42"], result: { json: "Success" } });
    const failed = await mocks.testMockHandler(mock.id, { code: "throw new Error('nope')" });
    expect(failed).toMatchObject({ ok: false, error: expect.stringContaining("nope") });
    expect(mocks.inspectMockState(mock.id).sessions).toHaveLength(0);
    await expect(mocks.testMockHandler(mock.id, { handlerId: "missing" })).rejects.toThrow(/not found/i);
    await expect(mocks.testMockHandler(mock.id, {})).rejects.toThrow(/code or a handlerId/);
  });

  it("includes handlers in exports and backups, and scrubs secrets from scrubbed backups", async () => {
    const { mock, workspace } = setup([
      handler(`return { body: "literal-secret-token-98765" }`, { id: "keep" }),
    ]);
    repo.replaceVariables(workspace.id, "global", null, [
      { key: "t", value: "literal-secret-token-98765", type: "secret", enabled: true },
    ]);
    const exported = mocks.exportMock(mock.id);
    expect(JSON.stringify(exported)).not.toContain("literal-secret-token-98765");
    expect(exported.handlers[0].id).toBe("keep");
    const full = backup.createBackup(dbm.getDb(), { includeSecrets: true });
    expect(JSON.stringify(full.tables.mockServers)).toContain("literal-secret-token-98765");
    const scrubbed = backup.createBackup(dbm.getDb(), { includeSecrets: false });
    expect(JSON.stringify(scrubbed.tables.mockServers)).not.toContain("literal-secret-token-98765");
    backup.restoreBackup(dbm.getDb(), dbm.getSqlite(), JSON.parse(JSON.stringify(full)));
    expect(mocks.getMock(mock.id).handlers[0]).toMatchObject({ id: "keep", enabled: true });
  });
});
