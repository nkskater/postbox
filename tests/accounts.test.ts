/**
 * User accounts (LAB-132): password hashing, account sessions, API tokens,
 * single-user compatibility and login rate limiting. Steps build on each other.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

process.env.DATABASE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "postbox-accounts-")), "a.db");

const auth = await import("@/server/auth");
const users = await import("@/server/users");
const { getDb, schema } = await import("@/server/db");
const { proxy } = await import("@/proxy");
const loginRoute = await import("@/app/api/auth/login/route");
const setupRoute = await import("@/app/api/auth/setup/route");
const statusRoute = await import("@/app/api/auth/status/route");
const meRoute = await import("@/app/api/me/route");
const passwordRoute = await import("@/app/api/me/password/route");
const tokensRoute = await import("@/app/api/me/tokens/route");
const tokenRoute = await import("@/app/api/me/tokens/[id]/route");

const ENV_TOKEN = "env-token-123";
afterEach(() => {
  delete process.env.POSTBOX_PASSWORD;
  delete process.env.POSTBOX_TOKEN;
});

let ip = 0;
/** Each request comes from its own address unless one is given, so IP limits stay out of the way. */
const req = (
  url: string,
  init: { body?: unknown; cookie?: string; bearer?: string; method?: string; ip?: string } = {},
) =>
  new Request(`http://localhost${url}`, {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers: {
      "Content-Type": "application/json",
      "x-forwarded-for": init.ip ?? `10.0.0.${++ip % 250}`,
      ...(init.cookie ? { cookie: `${auth.SESSION_COOKIE}=${init.cookie}` } : {}),
      ...(init.bearer ? { authorization: `Bearer ${init.bearer}` } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
const gate = (r: { cookie?: string; bearer?: string }) => {
  const headers = new Headers();
  if (r.cookie) headers.set("cookie", `${auth.SESSION_COOKIE}=${r.cookie}`);
  if (r.bearer) headers.set("authorization", `Bearer ${r.bearer}`);
  return proxy(new NextRequest("http://localhost/api/workspaces", { headers })).status;
};
const cookieOf = (res: Response) =>
  /postbox_session=([^;]*)/.exec(res.headers.get("set-cookie") ?? "")?.[1] ?? "";
const login = (username: string, password: string, ipAddr?: string) =>
  loginRoute.POST(req("/api/auth/login", { body: { username, password }, ip: ipAddr }));

describe("password hashing", () => {
  it("verifies scrypt hashes with a per-password salt", async () => {
    const a = await users.hashPassword("correct horse");
    const b = await users.hashPassword("correct horse");
    expect(a).toMatch(/^scrypt\$15\$8\$1\$/);
    expect(a).not.toBe(b);
    expect(await users.verifyPassword("correct horse", a)).toBe(true);
    expect(await users.verifyPassword("wrong horse", a)).toBe(false);
    expect(await users.verifyPassword("x", "garbage")).toBe(false);
  });
});

describe("account sessions", () => {
  it("rejects tampered, expired and v1 cookies", () => {
    const secret = Buffer.alloc(32, 1);
    const { value } = auth.createUserSession(secret, { id: "u1", sessionVersion: 3 }, 60_000, 1_000);
    expect(auth.parseUserSession(secret, value, 2_000)).toEqual({ userId: "u1", sessionVersion: 3 });
    expect(auth.parseUserSession(secret, value.replace(".u1.", ".u2."), 2_000)).toBeNull();
    expect(auth.parseUserSession(Buffer.alloc(32, 2), value, 2_000)).toBeNull();
    expect(auth.parseUserSession(secret, value, 70_000)).toBeNull();
    expect(auth.parseUserSession(secret, "v1.99999999999999.abc", 2_000)).toBeNull();
  });
});

describe("accounts end to end", () => {
  let adminCookie = "";
  let token = "";
  let tokenId = "";

  it("keeps single-user env login working while no account exists", async () => {
    process.env.POSTBOX_PASSWORD = "hunter2";
    process.env.POSTBOX_TOKEN = ENV_TOKEN;
    const res = await loginRoute.POST(req("/api/auth/login", { body: { password: "hunter2" } }));
    expect(res.status).toBe(200);
    const v1 = cookieOf(res);
    expect(v1.startsWith("v1.")).toBe(true);
    expect(gate({ cookie: v1 })).toBe(200);
    expect(gate({})).toBe(401);
    // With env credentials set, only the env admin can create the first account.
    const anon = await setupRoute.POST(
      req("/api/auth/setup", { body: { username: "root", password: "password1" } }),
    );
    expect(anon.status).toBe(401);
    const setup = await setupRoute.POST(
      req("/api/auth/setup", { body: { username: "Admin", password: "password1" }, cookie: v1 }),
    );
    expect(setup.status).toBe(201);
    adminCookie = cookieOf(setup);
    expect(adminCookie.startsWith("v2.")).toBe(true);
    // The single-user cookie stops working once accounts exist; the env token stays as recovery access.
    expect(gate({ cookie: v1 })).toBe(401);
    expect(gate({ bearer: ENV_TOKEN })).toBe(200);
    expect(gate({ cookie: adminCookie })).toBe(200);
    const status = await (await statusRoute.GET(req("/api/auth/status", { cookie: adminCookie }))).json();
    expect(status).toMatchObject({
      authEnabled: true,
      hasUsers: true,
      caller: { kind: "user", isAdmin: true },
    });
    expect(status.caller.user).toMatchObject({ username: "admin" });
    expect(status.caller.user.passwordHash).toBeUndefined();
  });

  it("logs in with username and password and refuses a second setup", async () => {
    const ok = await login("ADMIN ", "password1");
    expect(ok.status).toBe(200);
    expect(gate({ cookie: cookieOf(ok) })).toBe(200);
    expect((await login("admin", "nope")).status).toBe(401);
    expect((await login("nobody", "password1")).status).toBe(401);
    const again = await setupRoute.POST(
      req("/api/auth/setup", { body: { username: "x2", password: "password1" } }),
    );
    expect(again.status).toBe(409);
  });

  it("issues API tokens that are stored hashed, expire and can be revoked", async () => {
    const res = await tokensRoute.POST(req("/api/me/tokens", { body: { name: "mcp" }, cookie: adminCookie }));
    expect(res.status).toBe(201);
    const created = await res.json();
    token = created.token;
    tokenId = created.id;
    expect(token.startsWith("pbx_")).toBe(true);
    const stored = getDb().select().from(schema.apiTokens).all();
    expect(JSON.stringify(stored)).not.toContain(token);

    expect(gate({ bearer: token })).toBe(200);
    const me = await (await meRoute.GET(req("/api/me", { bearer: token }))).json();
    expect(me).toMatchObject({ kind: "user", user: { username: "admin" } });
    const list = await (await tokensRoute.GET(req("/api/me/tokens", { bearer: token }))).json();
    expect(list).toEqual([
      expect.objectContaining({ id: tokenId, name: "mcp", lastUsedAt: expect.any(Number) }),
    ]);
    expect(list[0].token).toBeUndefined();

    const admin = users.getUserByUsername("admin")!;
    const expiring = users.createToken(admin.id, "short", 1);
    expect(users.resolveToken(expiring.token, Date.now() + 2 * 86_400_000)).toBeNull();
    expect(gate({ bearer: "pbx_forged" })).toBe(401);

    const del = await tokenRoute.DELETE(
      req(`/api/me/tokens/${tokenId}`, { method: "DELETE", cookie: adminCookie }),
      {
        params: Promise.resolve({ id: tokenId }),
      },
    );
    expect(del.status).toBe(200);
    expect(gate({ bearer: token })).toBe(401);
    // Env and open callers have no account to attach tokens to.
    process.env.POSTBOX_TOKEN = ENV_TOKEN;
    expect((await tokensRoute.GET(req("/api/me/tokens", { bearer: ENV_TOKEN }))).status).toBe(400);
  });

  it("ends other sessions when the password changes", async () => {
    const other = cookieOf(await login("admin", "password1"));
    const wrong = await passwordRoute.POST(
      req("/api/me/password", {
        body: { currentPassword: "nope", newPassword: "password2" },
        cookie: adminCookie,
      }),
    );
    expect(wrong.status).toBe(403);
    const weak = await passwordRoute.POST(
      req("/api/me/password", {
        body: { currentPassword: "password1", newPassword: "short" },
        cookie: adminCookie,
      }),
    );
    expect(weak.status).toBe(400);
    const changed = await passwordRoute.POST(
      req("/api/me/password", {
        body: { currentPassword: "password1", newPassword: "password2" },
        cookie: adminCookie,
      }),
    );
    expect(changed.status).toBe(200);
    expect(gate({ cookie: other })).toBe(401);
    expect(gate({ cookie: adminCookie })).toBe(401);
    adminCookie = cookieOf(changed);
    expect(gate({ cookie: adminCookie })).toBe(200);
    expect((await login("admin", "password2")).status).toBe(200);
  });

  it("rejects disabled users' sessions, tokens and logins", async () => {
    const bob = await users.createUser({ username: "bob", password: "bobpassword" });
    const bobCookie = cookieOf(await login("bob", "bobpassword"));
    const bobToken = users.createToken(bob.id, "cli").token;
    expect(gate({ cookie: bobCookie })).toBe(200);
    expect(gate({ bearer: bobToken })).toBe(200);
    users.setDisabled(bob.id, true);
    expect(gate({ cookie: bobCookie })).toBe(401);
    expect(gate({ bearer: bobToken })).toBe(401);
    expect((await login("bob", "bobpassword")).status).toBe(401);
  });

  it("validates usernames and rejects duplicates", async () => {
    await expect(users.createUser({ username: "a", password: "password1" })).rejects.toThrow(/Username/);
    await expect(users.createUser({ username: "has space", password: "password1" })).rejects.toThrow(
      /Username/,
    );
    await expect(users.createUser({ username: "BOB", password: "password1" })).rejects.toThrow(/taken/);
  });

  it("rate limits failed logins per account across addresses", async () => {
    await users.createUser({ username: "carol", password: "carolpassword" });
    for (let i = 0; i < 10; i++) expect((await login("carol", "wrong")).status).toBe(401);
    expect((await login("carol", "carolpassword")).status).toBe(429);
    // Other accounts are not affected.
    expect((await login("admin", "password2")).status).toBe(200);
  });
});
