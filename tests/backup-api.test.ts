import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { UserRow } from "@/server/db/schema";
import type { Caller } from "@/server/caller";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-backup-api-"));
process.env.DATABASE_PATH = path.join(dir, "db.sqlite");
const users = await import("@/server/users");
const repo = await import("@/server/repo");
const { withCaller } = await import("@/server/access-context");
const { getSqlite } = await import("@/server/db");
const backupRoute = await import("@/app/api/backup/route");
const infoRoute = await import("@/app/api/backup/info/route");
const compactRoute = await import("@/app/api/backup/compact/route");
const clearRoute = await import("@/app/api/backup/clear/route");

let admin: UserRow;
let member: UserRow;
let workspaceId: string;
const as = (user: UserRow): Caller => ({ kind: "user", user: users.getUser(user.id)!, via: "token" });
const tokens = new Map<string, string>();
let current: UserRow | undefined;
const request = (method: string, url: string, body?: unknown, user?: UserRow) =>
  new Request(`http://localhost${url}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...((user ?? current) ? { authorization: `Bearer ${tokens.get((user ?? current)!.id)}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

beforeAll(async () => {
  admin = await users.createUser({ username: "root", password: "password123", isAdmin: true });
  member = await users.createUser({ username: "member", password: "password123" });
  for (const user of [admin, member]) tokens.set(user.id, users.createToken(user.id, "test").token);
  const folder = (() => {
    workspaceId = withCaller(as(admin), () => repo.createWorkspace("Original")).id;
    return withCaller(as(admin), () => repo.createFolder(workspaceId, null, { name: "Coll" }));
  })();
  withCaller(as(admin), () => {
    repo.replaceVariables(workspaceId, "collection", folder.id, [
      { key: "token", value: "api-secret-value-1", type: "secret", enabled: true },
      { key: "host", value: "example.test", type: "default", enabled: true },
    ]);
    repo.addHistory({ workspaceId, method: "GET", url: "https://e.test", request: {}, response: null });
  });
});
afterAll(() => {
  getSqlite().close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Handlers that take no declared arguments still authenticate from the request. */
const withRequest = (handler: unknown, req: Request) => (handler as (r: Request) => Promise<Response>)(req);
const run = <T>(user: UserRow, work: () => T): T => {
  current = user;
  try {
    return withCaller(as(user), work);
  } finally {
    current = undefined;
  }
};

describe("backup API", () => {
  it("is limited to administrators", async () => {
    const attempts: [string, () => Promise<Response> | Response][] = [
      ["download", () => backupRoute.GET(request("GET", "/api/backup"))],
      ["restore", () => backupRoute.POST(request("POST", "/api/backup", { backup: {}, confirm: "restore" }))],
      ["info", () => withRequest(infoRoute.GET, request("GET", "/api/backup/info"))],
      ["compact", () => withRequest(compactRoute.POST, request("POST", "/api/backup/compact"))],
      ["clear", () => clearRoute.POST(request("POST", "/api/backup/clear", { target: "history" }))],
    ];
    for (const [name, call] of attempts) expect((await run(member, call)).status, name).toBe(403);
  });

  it("downloads a backup, optionally without secrets", async () => {
    const full = await run(admin, () => backupRoute.GET(request("GET", "/api/backup")));
    expect(full.status).toBe(200);
    expect(full.headers.get("content-disposition")).toMatch(
      /^attachment; filename="postbox-backup-\d{4}-\d\d-\d\d\.json"$/,
    );
    expect(full.headers.get("cache-control")).toBe("no-store");
    const text = await full.text();
    expect(JSON.parse(text)).toMatchObject({ postboxBackup: 1, secretsIncluded: true });
    expect(text).toContain("api-secret-value-1");

    const scrubbed = await run(admin, () => backupRoute.GET(request("GET", "/api/backup?secrets=omit")));
    expect(scrubbed.headers.get("content-disposition")).toContain("-no-secrets-");
    const body = await scrubbed.text();
    expect(body).not.toContain("api-secret-value-1");
    expect(body).toContain("example.test");
    expect(JSON.parse(body).secretsIncluded).toBe(false);
  });

  it("restores only with explicit confirmation and a valid file, and replaces the data", async () => {
    const download = await run(admin, () => backupRoute.GET(request("GET", "/api/backup")));
    const backup = await download.json();

    const unconfirmed = await run(admin, () => backupRoute.POST(request("POST", "/api/backup", { backup })));
    expect(unconfirmed.status).toBe(400);
    const notABackup = await run(admin, () =>
      backupRoute.POST(request("POST", "/api/backup", { backup: { hello: 1 }, confirm: "restore" })),
    );
    expect(notABackup.status).toBe(400);
    expect(((await notABackup.json()) as { error: string }).error).toMatch(/not a Postbox backup/);

    // Change something, then restore: the change is undone and workspace ids are preserved.
    const before = run(admin, () => repo.listWorkspaces()).map((w) => [w.id, w.name]);
    expect(before.map(([, name]) => name)).toContain("Original");
    run(admin, () => repo.createWorkspace("Added after the backup"));
    expect(run(admin, () => repo.listWorkspaces())).toHaveLength(before.length + 1);
    const restored = await run(admin, () =>
      backupRoute.POST(request("POST", "/api/backup", { backup, confirm: "restore" })),
    );
    expect(restored.status).toBe(200);
    expect(((await restored.json()) as { restored: { workspaces: number } }).restored.workspaces).toBe(
      before.length,
    );
    const after = run(admin, () => repo.listWorkspaces()).map((w) => [w.id, w.name]);
    expect(after.sort()).toEqual([...before].sort());
    expect(after).toContainEqual([workspaceId, "Original"]);
  });

  it("reports database info, compacts and clears data", async () => {
    const info = await (
      await run(admin, () => withRequest(infoRoute.GET, request("GET", "/api/backup/info")))
    ).json();
    expect(info.path).toBe(process.env.DATABASE_PATH);
    expect(info.sizeBytes).toBeGreaterThan(0);
    expect(info.counts.workspaces).toBe(run(admin, () => repo.listWorkspaces()).length);

    const compact = await (
      await run(admin, () => withRequest(compactRoute.POST, request("POST", "/api/backup/compact")))
    ).json();
    expect(compact.before).toBeGreaterThan(0);
    expect(compact.after).toBeGreaterThan(0);

    run(admin, () =>
      repo.addHistory({ workspaceId, method: "GET", url: "https://e.test", request: {}, response: null }),
    );
    const missing = await run(admin, () =>
      clearRoute.POST(request("POST", "/api/backup/clear", { target: "history", workspaceId: "nope" })),
    );
    expect(missing.status).toBe(404);
    const invalid = await run(admin, () =>
      clearRoute.POST(request("POST", "/api/backup/clear", { target: "users" })),
    );
    expect(invalid.status).toBe(400);
    const cleared = await run(admin, () =>
      clearRoute.POST(request("POST", "/api/backup/clear", { target: "history", workspaceId })),
    );
    expect(((await cleared.json()) as { removed: number }).removed).toBeGreaterThanOrEqual(1);
    expect(repo.listHistory(workspaceId)).toHaveLength(0);
  });
});
