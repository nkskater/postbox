/**
 * LAB-277: sign-out ends the session on the server, and "Sign out of all sessions" ends every
 * browser session of the account. Steps build on each other.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATABASE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "postbox-revoke-")), "r.db");

const auth = await import("@/server/auth");
const clientAddressModule = await import("@/server/client-address");
clientAddressModule.installClientAddressHook();
const users = await import("@/server/users");
const { getDb, schema } = await import("@/server/db");
const loginRoute = await import("@/app/api/auth/login/route");
const logoutRoute = await import("@/app/api/auth/logout/route");
const meRoute = await import("@/app/api/me/route");
const revokeMineRoute = await import("@/app/api/me/sessions/revoke/route");
const { revokeSession } = await import("@/server/session-settings");

afterEach(() => {
  delete process.env.POSTBOX_PASSWORD;
});

let ip = 0;
const req = (url: string, init: { body?: unknown; cookie?: string; bearer?: string } = {}) =>
  new Request(`http://localhost${url}`, {
    method: init.body !== undefined ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      [clientAddressModule.CLIENT_ADDRESS_HEADER]: `10.1.0.${++ip % 250}`,
      ...(init.cookie ? { cookie: `${auth.SESSION_COOKIE}=${init.cookie}` } : {}),
      ...(init.bearer ? { authorization: `Bearer ${init.bearer}` } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
const cookieOf = (res: Response) =>
  /postbox_session=([^;]*)/.exec(res.headers.get("set-cookie") ?? "")?.[1] ?? "";
const signIn = async (username: string, password: string) => {
  const res = await loginRoute.POST(req("/api/auth/login", { body: { username, password } }));
  expect(res.status).toBe(200);
  return decodeURIComponent(cookieOf(res));
};
const me = async (cookie: string) => (await meRoute.GET(req("/api/me", { cookie }))).status;
const logout = (cookie: string) => logoutRoute.POST(req("/api/auth/logout", { body: {}, cookie }));

describe("server-side sign-out", () => {
  it("makes the old cookie value useless after logout, without touching other sessions", async () => {
    await users.createUser({ username: "alice", password: "alicepassword", isAdmin: true });
    const laptop = await signIn("alice", "alicepassword");
    const phone = await signIn("alice", "alicepassword");
    expect(await me(laptop)).toBe(200);

    const res = logout(laptop);
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
    // A copy of the cookie (another browser, a log) no longer works.
    expect(await me(laptop)).toBe(401);
    // The user's other session keeps working.
    expect(await me(phone)).toBe(200);
  });

  it("stores only a hash of the cookie, and ignores forged cookies", async () => {
    const before = getDb().select().from(schema.revokedSessions).all().length;
    logout("v2.nobody.1.99999999999999.forged");
    expect(getDb().select().from(schema.revokedSessions).all()).toHaveLength(before);
    const rows = getDb().select().from(schema.revokedSessions).all();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.id).not.toContain(".");
  });

  it("prunes revocations once the cookie would have expired anyway", () => {
    revokeSession("v2.x.1.1000.sig", 1_000, 0);
    revokeSession("v2.y.1.5000.sig", 5_000, 2_000);
    const ids = getDb().select().from(schema.revokedSessions).all();
    expect(ids.every((row) => row.expiresAt > 2_000)).toBe(true);
  });

  it("signs out of every session of the account from Profile", async () => {
    const one = await signIn("alice", "alicepassword");
    const two = await signIn("alice", "alicepassword");
    const token = (
      await (
        await import("@/app/api/me/tokens/route")
      ).POST(req("/api/me/tokens", { body: { name: "ci" }, cookie: one }))
    ).json();
    const res = await revokeMineRoute.POST(req("/api/me/sessions/revoke", { body: {}, cookie: one }));
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toMatch(/Max-Age=0/);
    expect(await me(one)).toBe(401);
    expect(await me(two)).toBe(401);
    // API tokens are not browser sessions and keep working.
    expect((await meRoute.GET(req("/api/me", { bearer: (await token).token }))).status).toBe(200);
    // Signing in again works.
    expect(await me(await signIn("alice", "alicepassword"))).toBe(200);
  });
});

describe("single-user password sessions", () => {
  it("reads the expiry from v1 and v2 cookies", async () => {
    const cfg = auth.getAuthConfig({ POSTBOX_PASSWORD: "pw" } as unknown as NodeJS.ProcessEnv)!;
    const { value } = auth.createSession(cfg);
    expect(auth.sessionExpiry(value)).toBeGreaterThan(Date.now());
    expect(auth.sessionExpiry("v2.u.1.1234.sig")).toBe(1234);
    expect(auth.sessionExpiry("junk")).toBeNaN();
  });
});
