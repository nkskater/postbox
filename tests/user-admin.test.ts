import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { UserRow } from "@/server/db/schema";
import type { Caller } from "@/server/caller";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-admin-"));
process.env.DATABASE_PATH = path.join(dir, "db.sqlite");
const users = await import("@/server/users");
const invites = await import("@/server/invites");
const settings = await import("@/server/settings");
const { withCaller } = await import("@/server/access-context");
const { getDb, getSqlite, schema, openDatabase } = await import("@/server/db");
const { authorize, setMember } = await import("@/server/authorize");
const { SETTINGS, SETTINGS_BY_KEY } = await import("@/lib/settings/registry");
const adminRoute = await import("@/app/api/admin/users/route");
const userRoute = await import("@/app/api/admin/users/[id]/route");
const revokeRoute = await import("@/app/api/admin/users/[id]/revoke/route");
const inviteRoute = await import("@/app/api/invites/route");
const acceptRoute = await import("@/app/api/auth/invite/route");
const settingsRoute = await import("@/app/api/settings/route");
const mcpRoute = await import("@/app/api/mcp/route");
const repo = await import("@/server/repo");
let admin: UserRow, owner: UserRow, stranger: UserRow;
const caller = (user: UserRow): Caller => ({ kind: "user", user: users.getUser(user.id)!, via: "token" });
const tokens: Record<string, string> = {};
let workspaceId: string;
const req = (method: string, url: string, user?: UserRow, body?: unknown) =>
  new Request("http://localhost" + url, {
    method,
    headers: {
      "content-type": "application/json",
      ...(user ? { authorization: `Bearer ${tokens[user.id]}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
beforeAll(async () => {
  settings.patchSettings({ "appearance.theme": "light" });
  admin = await users.createUser({ username: "root", password: "password123", isAdmin: true });
  owner = await users.createUser({ username: "owner", password: "password123" });
  stranger = await users.createUser({ username: "stranger", password: "password123" });
  for (const user of [admin, owner, stranger]) tokens[user.id] = users.createToken(user.id, "testing").token;
  workspaceId = withCaller(caller(owner), () => repo.createWorkspace("Shared invite workspace")).id;
});
afterAll(() => {
  getSqlite().close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("admin user management", () => {
  it("rejects every non-admin administration operation before mutation", async () => {
    expect((await adminRoute.GET(req("GET", "/api/admin/users", owner))).status).toBe(403);
    expect(
      (
        await adminRoute.POST(
          req("POST", "/api/admin/users", owner, { username: "not-created", password: "password123" }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await userRoute.PATCH(
          req("PATCH", `/api/admin/users/${admin.id}`, owner, { disabled: true }),
          ctx(admin.id),
        )
      ).status,
    ).toBe(403);
    expect(
      (await revokeRoute.POST(req("POST", `/api/admin/users/${admin.id}/revoke`, owner), ctx(admin.id)))
        .status,
    ).toBe(403);
    expect(users.getUserByUsername("not-created")).toBeUndefined();
  });
  it("protects the last active administrator atomically, including concurrent demotions", async () => {
    for (const patch of [{ isAdmin: false }, { disabled: true }])
      expect(
        (await userRoute.PATCH(req("PATCH", `/api/admin/users/${admin.id}`, admin, patch), ctx(admin.id)))
          .status,
      ).toBe(409);
    const second = await users.createUser({
      username: "second-admin",
      password: "password123",
      isAdmin: true,
    });
    const outcomes = await Promise.allSettled([
      users.updateManagedUser(admin.id, { isAdmin: false }),
      users.updateManagedUser(second.id, { disabled: true }),
    ]);
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    expect(users.listUsers().filter((u) => u.isAdmin && !u.disabled)).toHaveLength(1);
    await users.updateManagedUser(admin.id, { isAdmin: true, disabled: false });
    await users.updateManagedUser(second.id, { isAdmin: false });
  });
  it("creates users, resets passwords, toggles roles and revokes sessions/tokens without exposing hashes", async () => {
    const response = await adminRoute.POST(
      req("POST", "/api/admin/users", admin, {
        username: "managed",
        displayName: "Managed user",
        password: "password123",
      }),
    );
    expect(response.status).toBe(201);
    const managed = await response.json();
    expect(managed.passwordHash).toBeUndefined();
    const { token } = users.createToken(managed.id, "old token");
    const original = users.getUser(managed.id)!;
    expect(
      (
        await userRoute.PATCH(
          req("PATCH", `/api/admin/users/${managed.id}`, admin, {
            password: "newpassword123",
            isAdmin: true,
          }),
          ctx(managed.id),
        )
      ).status,
    ).toBe(200);
    expect(await users.verifyPassword("newpassword123", users.getUser(managed.id)!.passwordHash)).toBe(true);
    expect(users.getUser(managed.id)!.sessionVersion).toBeGreaterThan(original.sessionVersion);
    expect(
      (await revokeRoute.POST(req("POST", `/api/admin/users/${managed.id}/revoke`, admin), ctx(managed.id)))
        .status,
    ).toBe(200);
    expect(users.resolveToken(token)).toBeNull();
    for (const disabled of [true, false])
      expect(
        (
          await userRoute.PATCH(
            req("PATCH", `/api/admin/users/${managed.id}`, admin, { disabled }),
            ctx(managed.id),
          )
        ).status,
      ).toBe(200);
    const list = await (await adminRoute.GET(req("GET", "/api/admin/users", admin))).json();
    expect(JSON.stringify(list)).not.toContain("passwordHash");
    expect(JSON.stringify(list)).not.toContain("sessionVersion");
  });
});

describe("single-use invitation links", () => {
  it("allows owners only for their workspace, and administrators for account-only invites", async () => {
    expect((await inviteRoute.POST(req("POST", "/api/invites", stranger, { workspaceId }))).status).toBe(404);
    expect((await inviteRoute.POST(req("POST", "/api/invites", owner, {}))).status).toBe(403);
    const created = await inviteRoute.POST(
      req("POST", "/api/invites", owner, { workspaceId, role: "viewer", expiresInHours: 24 }),
    );
    expect(created.status).toBe(201);
    const invite = await created.json();
    const stored = getDb().select().from(schema.invites).where(eq(schema.invites.id, invite.id)).get()!;
    expect(stored.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(invite.token);
    expect(JSON.stringify(withCaller(caller(owner), () => invites.listInvites(workspaceId)))).not.toContain(
      invite.token,
    );
    const accepted = await acceptRoute.POST(
      req("POST", "/api/auth/invite", undefined, {
        token: invite.token,
        username: "invited",
        password: "password123",
      }),
    );
    expect(accepted.status).toBe(201);
    expect(accepted.headers.get("set-cookie")).toContain("postbox_session=v2.");
    const user = users.getUser((await accepted.json()).user.id)!;
    expect(user.isAdmin).toBe(false);
    expect(() => authorize(caller(user), workspaceId, "read")).not.toThrow();
    expect(() => authorize(caller(user), workspaceId, "write")).toThrow(/Insufficient/);
    expect(
      (
        await acceptRoute.POST(
          req("POST", "/api/auth/invite", undefined, {
            token: invite.token,
            username: "reused",
            password: "password123",
          }),
        )
      ).status,
    ).toBe(410);
    expect(users.getUserByUsername("reused")).toBeUndefined();
  });
  it("expires, revokes and rechecks creator permissions", async () => {
    const make = () =>
      withCaller(caller(owner), () => invites.createInvite({ workspaceId, expiresInHours: 1 }));
    const expired = make();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(expired.expiresAt + 1);
      await expect(
        invites.acceptInvite(expired.token, { username: "expired", password: "password123" }),
      ).rejects.toMatchObject({ status: 410 });
    } finally {
      vi.useRealTimers();
    }
    const revoked = make();
    withCaller(caller(owner), () => invites.revokeInvite(revoked.id));
    await expect(
      invites.acceptInvite(revoked.token, { username: "revoked", password: "password123" }),
    ).rejects.toMatchObject({ status: 410 });
    const lost = make();
    withCaller(caller(admin), () => {
      setMember(workspaceId, admin.username, "owner");
      setMember(workspaceId, owner.username, "viewer");
    });
    await expect(
      invites.acceptInvite(lost.token, { username: "lost-owner", password: "password123" }),
    ).rejects.toMatchObject({ status: 403 });
    withCaller(caller(admin), () => setMember(workspaceId, owner.username, "owner"));
  });
  it("consumes once under concurrent acceptance and rolls back failed account creation", async () => {
    const invite = withCaller(caller(admin), () => invites.createInvite({}));
    await expect(
      invites.acceptInvite(invite.token, { username: "owner", password: "password123" }),
    ).rejects.toMatchObject({ status: 409 });
    const attempts = await Promise.allSettled([
      invites.acceptInvite(invite.token, { username: "race-one", password: "password123" }),
      invites.acceptInvite(invite.token, { username: "race-two", password: "password123" }),
    ]);
    expect(attempts.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((r) => r.status === "rejected")).toHaveLength(1);
  });
});

describe("per-user settings", () => {
  it("moves bootstrap preferences to the first administrator and isolates other accounts", () => {
    expect(withCaller(caller(admin), () => settings.getSettings().values["appearance.theme"])).toBe("light");
    expect(withCaller(caller(owner), () => settings.getSettings().values["appearance.theme"])).toBe("dark");
    expect(getDb().select().from(schema.appSettings).all()).toEqual([]);
    withCaller(caller(owner), () =>
      settings.patchSettings({ "appearance.theme": "light", "editor.fontSize": 16 }),
    );
    withCaller(caller(stranger), () => settings.patchSettings({ "appearance.theme": "dark" }));
    expect(withCaller(caller(stranger), () => settings.exportSettings().settings)).toEqual({
      "appearance.theme": "dark",
    });
    withCaller(caller(owner), () => settings.importSettings({ "appearance.theme": "system" }));
    expect(withCaller(caller(owner), () => settings.getSettings().saved)).toEqual({
      "appearance.theme": "system",
    });
    expect(withCaller(caller(stranger), () => settings.getSettings().saved)).toEqual({
      "appearance.theme": "dark",
    });
  });
  it("allows browser preferences through REST and restricts instance settings atomically", async () => {
    SETTINGS.push({
      key: "server.testLimit",
      category: "requests",
      label: "Test limit",
      description: "Test fixture",
      scope: "server",
      type: "number",
      default: 5,
      min: 1,
      max: 100,
    });
    SETTINGS_BY_KEY.set("server.testLimit", SETTINGS.at(-1)!);
    try {
      const update = (user: UserRow, values: Record<string, unknown>) =>
        settingsRoute.PATCH(req("PATCH", "/api/settings", user, { values }));
      expect((await update(admin, { "server.testLimit": 12 })).status).toBe(200);
      expect((await update(owner, { "server.testLimit": 20, "appearance.theme": "light" })).status).toBe(403);
      expect(withCaller(caller(owner), () => settings.getSettings().values["appearance.theme"])).toBe(
        "system",
      );
      expect((await update(owner, { "appearance.theme": "light" })).status).toBe(200);
      withCaller(caller(owner), () => settings.importSettings({}));
      expect(withCaller(caller(owner), () => settings.getSettings().values["server.testLimit"])).toBe(12);
      expect(withCaller(caller(owner), () => settings.getSettings().environment)).toEqual([]);
    } finally {
      SETTINGS.pop();
      SETTINGS_BY_KEY.delete("server.testLimit");
    }
  });
  it("migrates existing shared preferences to the first administrator only", () => {
    const oldDir = path.join(dir, "legacy-migrations");
    fs.mkdirSync(path.join(oldDir, "meta"), { recursive: true });
    const journal = JSON.parse(fs.readFileSync("drizzle/meta/_journal.json", "utf8"));
    journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx < 7);
    for (const entry of journal.entries)
      fs.copyFileSync(`drizzle/${entry.tag}.sql`, path.join(oldDir, `${entry.tag}.sql`));
    fs.writeFileSync(path.join(oldDir, "meta/_journal.json"), JSON.stringify(journal));
    process.env.MIGRATIONS_PATH = oldDir;
    const file = path.join(dir, "upgrade.db");
    const legacy = openDatabase(file);
    delete process.env.MIGRATIONS_PATH;
    legacy.sqlite
      .prepare(
        "INSERT INTO users (id,username,password_hash,is_admin,created_at,updated_at) VALUES ('old-admin','old','unused',1,1,1)",
      )
      .run();
    legacy.sqlite
      .prepare(
        "INSERT INTO app_settings (key,value,updated_at) VALUES ('appearance.theme','\"light\"',1),('server.retained','10',1)",
      )
      .run();
    legacy.sqlite.close();
    const upgraded = openDatabase(file);
    expect(upgraded.sqlite.prepare("SELECT user_id,key,value FROM user_settings").all()).toEqual([
      { user_id: "old-admin", key: "appearance.theme", value: '"light"' },
    ]);
    expect(upgraded.sqlite.prepare("SELECT key FROM app_settings").all()).toEqual([
      { key: "server.retained" },
    ]);
    upgraded.sqlite.close();
  });
});

it("whoami reports the caller and only their accessible workspace roles", async () => {
  const response = await mcpRoute.POST(
    req("POST", "/api/mcp", stranger, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "whoami", arguments: {} },
    }),
  );
  const payload = await response.json();
  const identity = JSON.parse(payload.result.content[0].text);
  expect(identity.user.id).toBe(stranger.id);
  expect(identity.workspaces.some((workspace: { id: string }) => workspace.id === workspaceId)).toBe(false);
});
