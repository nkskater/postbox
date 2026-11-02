import { beforeAll, afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { UserRow } from "@/server/db/schema";
import type { Caller } from "@/server/caller";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-monitor-api-"));
process.env.DATABASE_PATH = path.join(dir, "test.db");
const repo = await import("@/server/repo"),
  users = await import("@/server/users"),
  monitors = await import("@/server/monitors"),
  scheduler = await import("@/server/scheduler");
const { withCaller } = await import("@/server/access-context"),
  { setMember } = await import("@/server/authorize"),
  { getSqlite } = await import("@/server/db");
const as = (user: UserRow): Caller => ({ kind: "user", user, via: "token" });
let owner: UserRow, viewer: UserRow, outsider: UserRow, ws: string, folder: string, environmentId: string;
const tokens: Record<string, string> = {};
beforeAll(async () => {
  owner = await users.createUser({ username: "monitor-owner", password: "password123" });
  viewer = await users.createUser({ username: "monitor-viewer", password: "password123" });
  outsider = await users.createUser({ username: "monitor-outsider", password: "password123" });
  for (const user of [owner, viewer, outsider]) tokens[user.id] = users.createToken(user.id, "test").token;
  withCaller(as(owner), () => {
    ws = repo.createWorkspace("Monitor auth").id;
    folder = repo.createFolder(ws, null).id;
    environmentId = repo.createEnvironment(ws, "Stage").id;
    setMember(ws, viewer.username, "viewer");
  });
});
afterAll(() => {
  scheduler.stopScheduler();
  getSqlite().close();
  fs.rmSync(dir, { recursive: true, force: true });
});
async function request(method: string, pathname: string, user: UserRow, body?: unknown, id = "") {
  const mod = id
    ? pathname.endsWith("/run")
      ? await import("@/app/api/monitors/[id]/run/route")
      : await import("@/app/api/monitors/[id]/route")
    : await import("@/app/api/monitors/route");
  const handler = (
    mod as unknown as Record<
      string,
      (r: Request, c: { params: Promise<{ id: string }> }) => Promise<Response>
    >
  )[method];
  return handler(
    new Request("http://localhost/api/monitors" + pathname, {
      method,
      headers: { authorization: `Bearer ${tokens[user.id]}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    }),
    { params: Promise.resolve({ id }) },
  );
}
describe("monitor authorization and explicit configuration changes", () => {
  it("enforces owner/editor/viewer and foreign-workspace boundaries on CRUD and execution", async () => {
    const create = {
      workspaceId: ws,
      folderId: folder,
      name: "Owned monitor",
      cron: "0 0 1 1 *",
      enabled: false,
      environmentId,
    };
    expect((await request("POST", "", viewer, create)).status).toBe(403);
    const response = await request("POST", "", owner, create);
    expect(response.status, await response.clone().text()).toBe(201);
    const saved = await response.json();
    expect((await request("GET", "?workspaceId=" + ws, viewer)).status).toBe(200);
    expect((await request("GET", "/" + saved.id, outsider, undefined, saved.id)).status).toBe(404);
    expect(
      (await request("PATCH", "/" + saved.id, viewer, { name: "No", expectedRevision: 1 }, saved.id)).status,
    ).toBe(403);
    expect((await request("POST", "/" + saved.id + "/run", viewer, undefined, saved.id)).status).toBe(403);
    expect((await request("DELETE", "/" + saved.id, outsider, undefined, saved.id)).status).toBe(404);
    expect((await request("DELETE", "/" + saved.id, owner, undefined, saved.id)).status).toBe(200);
  });
  it("does not reset omitted settings when patching a name, detects stale revisions and validates history filters", () => {
    const saved = withCaller(as(owner), () =>
      monitors.createMonitor({
        workspaceId: ws,
        folderId: folder,
        name: "Patch",
        cron: "0 0 1 1 *",
        enabled: false,
        environmentId,
        rules: { minAvailability: 75, minAssertions: 90, failAfter: 3, timeoutMs: 500 },
      }),
    );
    const updated = withCaller(as(owner), () =>
      monitors.updateMonitor(saved.id, { name: "Renamed", expectedRevision: 1 }),
    );
    expect(updated.enabled).toBe(false);
    expect(updated.environmentId).toBe(environmentId);
    expect(updated.rules).toEqual(saved.rules);
    expect(() =>
      withCaller(as(owner), () => monitors.updateMonitor(saved.id, { name: "Stale", expectedRevision: 1 })),
    ).toThrow("changed");
    expect(() => withCaller(as(owner), () => monitors.getMonitor(saved.id, 0))).toThrow("hours");
  });
});
