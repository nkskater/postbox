import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { eq } from "drizzle-orm";
import type { Caller } from "@/server/caller";
import type { UserRow } from "@/server/db/schema";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-access-"));
process.env.DATABASE_PATH = path.join(dir, "test.db");
const { getDb, getSqlite, schema } = await import("@/server/db");
const users = await import("@/server/users");
const repo = await import("@/server/repo");
const { withCaller } = await import("@/server/access-context");
const { authorize, setMember, ROLE_ACTIONS } = await import("@/server/authorize");
const { REST_POLICIES, MCP_POLICIES, authorizeTool } = await import("@/server/access-policy");
const scheduler = await import("@/server/scheduler");
const mcpRoute = await import("@/app/api/mcp/route");
const caller = (user: UserRow): Caller => ({ kind: "user", user, via: "token" });
let owner: UserRow, viewer: UserRow, editor: UserRow, outsider: UserRow, admin: UserRow;
let workspaceId: string;
const ids: Record<string, string> = {};
const tokens: Record<string, string> = {};

beforeAll(async () => {
  repo.createWorkspace("Before accounts");
  admin = await users.createUser({ username: "admin", password: "password123", isAdmin: true });
  owner = await users.createUser({ username: "owner", password: "password123" });
  viewer = await users.createUser({ username: "viewer", password: "password123" });
  editor = await users.createUser({ username: "editor", password: "password123" });
  outsider = await users.createUser({ username: "outsider", password: "password123" });
  workspaceId = withCaller(caller(owner), () => repo.createWorkspace("Shared")).id;
  withCaller(caller(owner), () => {
    setMember(workspaceId, viewer.username, "viewer");
    setMember(workspaceId, editor.username, "editor");
  });
  ids.workspace = workspaceId;
  ids.folder = repo.createFolder(workspaceId, null).id;
  ids.request = repo.createRequest(workspaceId, ids.folder, { url: "http://127.0.0.1:1/" }).id;
  ids.environment = repo.createEnvironment(workspaceId, "Environment").id;
  ids.history = withCaller(caller(owner), () =>
    repo.addHistory({
      workspaceId,
      requestId: ids.request,
      method: "GET",
      url: "https://example.test",
      status: 200,
      request: {},
    }),
  );
  repo.saveCookies(workspaceId, {
    upserts: [
      { name: "cookie", value: "secret", domain: "example.test", path: "/", httpOnly: false, secure: false },
    ],
    deletions: [],
  });
  ids.cookie = repo.listCookies(workspaceId)[0].id;
  ids.schedule = withCaller(caller(owner), () =>
    scheduler.createSchedule({
      workspaceId,
      folderId: ids.folder,
      name: "Daily",
      cron: "0 0 * * *",
      enabled: false,
    }),
  ).id;
  ids.run = "saved-run";
  getDb()
    .insert(schema.runs)
    .values({
      id: ids.run,
      workspaceId,
      folderId: ids.folder,
      name: "Saved",
      status: "passed",
      options: { iterations: 1, delayMs: 0, stopOnFailure: false, persistVariables: true },
      startedAt: Date.now(),
      createdBy: owner.id,
    })
    .run();
  for (const user of [owner, viewer, editor, outsider, admin])
    tokens[user.id] = users.createToken(user.id, "test").token;
});
afterAll(() => {
  scheduler.stopScheduler();
  getSqlite().close();
  fs.rmSync(dir, { recursive: true, force: true });
});
const request = (method: string, url: string, user: UserRow, body?: unknown) =>
  new Request(`http://localhost${url}`, {
    method,
    headers: { authorization: `Bearer ${tokens[user.id]}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

function routeFiles(directory: string): string[] {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? routeFiles(path.join(directory, entry.name))
        : entry.name === "route.ts"
          ? [path.join(directory, entry.name)]
          : [],
    );
}
const root = path.resolve("src/app/api");
const entries = routeFiles(root).flatMap((file) => {
  const source = fs.readFileSync(file, "utf8");
  const template = "/api/" + path.relative(root, file).replace(/\/route.ts$/, "");
  return [
    ...source.matchAll(/export (?:const|(?:async )?function) (GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\b/g),
  ].map((match) => ({ file, source, key: `${match[1]} ${template}`, method: match[1] }));
});

describe("explicit authorization inventory", () => {
  it("classifies every route and keeps workspace handlers behind the authorization wrapper", () => {
    expect(entries.map((e) => e.key).sort()).toEqual(Object.keys(REST_POLICIES).sort());
    for (const entry of entries) {
      const policy = REST_POLICIES[entry.key];
      if (policy.action) expect(entry.source).toMatch(new RegExp(`export const ${entry.method} = route\\(`));
    }
    const tools = [
      ...fs.readFileSync("src/server/mcp.ts", "utf8").matchAll(/server.registerTool\(\s*"([^"]+)"/g),
    ].map((m) => m[1]);
    expect(tools.sort()).toEqual(Object.keys(MCP_POLICIES).sort());
  });
  for (const entry of entries.filter((e) => REST_POLICIES[e.key]?.action)) {
    it(`isolates foreign users before handler work: ${entry.key}`, async () => {
      const policy = REST_POLICIES[entry.key];
      const id = ids[policy.kind ?? "workspace"];
      const url = entry.key.split(" ")[1].replace("[id]", id) + `?workspaceId=${workspaceId}`;
      const body = ["POST", "PUT", "PATCH", "DELETE"].includes(entry.method)
        ? { workspaceId, id: ids.request, kind: "request" }
        : undefined;
      const handlers = (await import(pathToFileURL(entry.file).href)) as Record<
        string,
        (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>
      >;
      expect(
        (
          await handlers[entry.method](request(entry.method, url, outsider, body), {
            params: Promise.resolve({ id }),
          })
        ).status,
      ).toBe(404);
      if (policy.action !== "read")
        expect(
          (
            await handlers[entry.method](request(entry.method, url, viewer, body), {
              params: Promise.resolve({ id }),
            })
          ).status,
        ).toBe(403);
    });
  }
});

describe("workspace membership roles", () => {
  it("enforces every role/action combination and administrator override", () => {
    for (const [user, role] of [
      [viewer, "viewer"],
      [editor, "editor"],
      [owner, "owner"],
    ] as const) {
      for (const action of ["read", "write", "run", "manage"] as const) {
        if (ROLE_ACTIONS[role].includes(action))
          expect(() => authorize(caller(user), workspaceId, action)).not.toThrow();
        else expect(() => authorize(caller(user), workspaceId, action)).toThrow(/Insufficient/);
      }
    }
    expect(() => authorize(caller(admin), workspaceId, "manage")).not.toThrow();
    expect(() => authorize(caller(outsider), workspaceId, "read")).toThrow(/not found/);
  });
  it("backfills the first administrator and creates a private workspace for every account", () => {
    const old = repo.listWorkspaces().find((ws) => ws.name === "Before accounts")!;
    expect(
      getSqlite().prepare("SELECT user_id, role FROM workspace_members WHERE workspace_id=?").get(old.id),
    ).toEqual({ user_id: admin.id, role: "owner" });
    for (const user of [admin, owner, viewer, editor, outsider]) {
      const visible = withCaller(caller(user), () => repo.listWorkspaces());
      expect(visible.some((ws) => ws.name === `${user.displayName}'s Workspace`)).toBe(true);
      if (user.id === outsider.id) expect(visible.some((ws) => ws.id === workspaceId)).toBe(false);
    }
  });
  it("migrates ownership for existing account databases", async () => {
    const { openDatabase } = await import("@/server/db");
    const oldDir = path.join(dir, "old-migrations");
    fs.mkdirSync(path.join(oldDir, "meta"), { recursive: true });
    const journal = JSON.parse(fs.readFileSync("drizzle/meta/_journal.json", "utf8"));
    journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx < 6);
    for (const entry of journal.entries)
      fs.copyFileSync(`drizzle/${entry.tag}.sql`, path.join(oldDir, `${entry.tag}.sql`));
    fs.writeFileSync(path.join(oldDir, "meta/_journal.json"), JSON.stringify(journal));
    const file = path.join(dir, "upgrade.db");
    const previous = process.env.MIGRATIONS_PATH;
    process.env.MIGRATIONS_PATH = oldDir;
    const legacy = openDatabase(file);
    legacy.sqlite
      .prepare(
        "INSERT INTO users (id,username,password_hash,is_admin,disabled,created_at,updated_at) VALUES ('legacy-admin','legacy','unused',1,0,1,1)",
      )
      .run();
    legacy.sqlite
      .prepare("INSERT INTO workspaces (id,name,created_at,updated_at) VALUES ('legacy-ws','Existing',1,1)")
      .run();
    legacy.sqlite
      .prepare(
        "INSERT INTO schedules (id,workspace_id,name,folder_id,cron,options,created_at,updated_at) VALUES ('legacy-job','legacy-ws','Job','folder','0 0 * * *','{}',1,1)",
      )
      .run();
    legacy.sqlite.close();
    if (previous === undefined) delete process.env.MIGRATIONS_PATH;
    else process.env.MIGRATIONS_PATH = previous;
    const upgraded = openDatabase(file);
    expect(
      upgraded.sqlite
        .prepare("SELECT user_id,role FROM workspace_members WHERE workspace_id='legacy-ws'")
        .get(),
    ).toEqual({ user_id: "legacy-admin", role: "owner" });
    expect(upgraded.sqlite.prepare("SELECT created_by FROM schedules WHERE id='legacy-job'").get()).toEqual({
      created_by: "legacy-admin",
    });
    upgraded.sqlite.close();
  });

  it("filters REST/MCP workspace lists and prevents deleting the last owner", async () => {
    const route = await import("@/app/api/workspaces/route");
    const response = await route.GET(request("GET", "/api/workspaces", outsider));
    expect((await response.json()).some((ws: { id: string }) => ws.id === workspaceId)).toBe(false);
    withCaller(caller(owner), () =>
      expect(() => setMember(workspaceId, owner.username, "viewer")).toThrow(/retain an owner/),
    );
    expect(repo.getHistory(ids.history)?.createdBy).toBe(owner.id);
  });
  it("attributes actual executions and history to the initiating account", async () => {
    const { startRun } = await import("@/server/runs");
    const { runSingleRequest } = await import("@/server/context");
    const run = await withCaller(caller(editor), () =>
      startRun({ workspaceId, folderId: ids.folder, environmentId: null }),
    );
    expect(getDb().select().from(schema.runs).where(eq(schema.runs.id, run.runId)).get()?.createdBy).toBe(
      editor.id,
    );
    const single = await withCaller(caller(editor), () =>
      runSingleRequest({
        workspaceId,
        folderId: ids.folder,
        environmentId: null,
        request: repo.getRequest(ids.request)!,
      }),
    );
    expect(repo.getHistory(single.historyId!)?.createdBy).toBe(editor.id);
  });

  it("rejects unclassified tools and routes", async () => {
    expect(() => authorizeTool(caller(admin), "new_unclassified_tool", {})).toThrow(/no access policy/);
    const { route, json } = await import("@/server/http");
    const fn = route((_req: Request) => json({ secret: "not reached" }));
    expect((await fn(request("POST", "/api/new-unclassified", admin, {}))).status).toBe(403);
  });
});

describe("MCP role enforcement", () => {
  for (const [name, action] of Object.entries(MCP_POLICIES)) {
    if (["list", "create", "identity"].includes(action)) continue;
    it(`guards ${name}`, async () => {
      const args = {
        workspaceId,
        folderId: ids.folder,
        requestId: ids.request,
        environmentId: ids.environment,
        runId: ids.run,
        historyId: ids.history,
        cookieId: ids.cookie,
        kind: "request",
        id: ids.request,
      };
      const invoke = async (user: UserRow) =>
        (
          await mcpRoute.POST(
            request("POST", "/api/mcp", user, {
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: { name, arguments: args },
            }),
          )
        ).json();
      const foreign = await invoke(outsider);
      expect(JSON.parse(foreign.result.content[0].text).status).toBe(404);
      if (action !== "read") {
        const denied = await invoke(viewer);
        expect(JSON.parse(denied.result.content[0].text).status).toBe(403);
      }
    });
  }
  it("blocks foreign MCP resource reads", async () => {
    for (const [kind, id] of [
      ["workspaces", workspaceId],
      ["folders", ids.folder],
      ["requests", ids.request],
      ["environments", ids.environment],
    ]) {
      const response = await mcpRoute.POST(
        request("POST", "/api/mcp", outsider, {
          jsonrpc: "2.0",
          id: 1,
          method: "resources/read",
          params: { uri: `postbox://${kind}/${id}` },
        }),
      );
      expect(response.status).toBe(404);
    }
  });
});

describe("schedule authorization", () => {
  it("records the creator and disables schedules after access is revoked", async () => {
    const other = await users.createUser({ username: "scheduled", password: "password123" });
    withCaller(caller(owner), () => setMember(workspaceId, other.username, "editor"));
    const schedule = withCaller(caller(other), () =>
      scheduler.createSchedule({
        workspaceId,
        folderId: ids.folder,
        cron: "0 0 * * *",
        name: "User job",
        enabled: false,
      }),
    );
    expect(schedule.createdBy).toBe(other.id);
    withCaller(caller(owner), () => setMember(workspaceId, other.username, null));
    const start = vi.spyOn(await import("@/server/runs"), "startRun");
    await expect(scheduler.runSchedule(schedule.id)).rejects.toMatchObject({ status: 404 });
    expect(start).not.toHaveBeenCalled();
    start.mockRestore();
    expect(
      getDb().select().from(schema.schedules).where(eq(schema.schedules.id, schedule.id)).get()?.enabled,
    ).toBe(false);
  });
});
