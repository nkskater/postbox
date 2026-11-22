/**
 * The per-request caches (db-cache.ts) must never let a change wait: each of these takes
 * effect on the very next request.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { UserRow } from "@/server/db/schema";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-request-cache-"));
const file = path.join(dir, "test.db");
process.env.DATABASE_PATH = file;
delete process.env.POSTBOX_PASSWORD;
delete process.env.POSTBOX_TOKEN;
const { getSqlite } = await import("@/server/db");
const users = await import("@/server/users");
const { createUserSession, SESSION_COOKIE, sessionExpiry } = await import("@/server/auth");
const { callerOf, getAuthState, sessionSecret } = await import("@/server/caller");
const { revokeSession, sessionTtl } = await import("@/server/session-settings");
const { withCaller } = await import("@/server/access-context");
const { patchSettings } = await import("@/server/settings");
const { historySettings } = await import("@/server/execution-settings");
const { changeStamp } = await import("@/server/db-cache");

const request = (headers: Record<string, string> = {}) => new Request("http://localhost/api/me", { headers });
const bearer = (token: string) => request({ authorization: `Bearer ${token}` });
let admin: UserRow;

beforeAll(() => {
  getSqlite();
});

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("cached request lookups", () => {
  it("the first account turns sign-in on for the next request", async () => {
    expect(callerOf(request())).toEqual({ kind: "open" });
    expect(getAuthState().enabled).toBe(false);
    admin = await users.createUser({ username: "admin", password: "password123", isAdmin: true });
    expect(getAuthState()).toMatchObject({ enabled: true, hasUsers: true });
    expect(callerOf(request())).toBeNull();
  });

  it("reuses the caller while nothing changed", () => {
    const { token } = users.createToken(admin.id, "reuse");
    const first = callerOf(bearer(token));
    expect(first).toMatchObject({ kind: "user", via: "token" });
    expect(callerOf(bearer(token))).toBe(first);
  });

  it("a revoked API key stops working on the next request", () => {
    const { token, info } = users.createToken(admin.id, "revoke");
    expect(callerOf(bearer(token))).toMatchObject({ kind: "user" });
    expect(callerOf(bearer(token))).toMatchObject({ kind: "user" });
    users.revokeToken(admin.id, info.id);
    expect(callerOf(bearer(token))).toBeNull();
  });

  it("a disabled user is refused on the next request", async () => {
    const user = await users.createUser({ username: "member", password: "password123" });
    const { token } = users.createToken(user.id, "member");
    expect(callerOf(bearer(token))).toMatchObject({ kind: "user" });
    users.setDisabled(user.id, true);
    expect(callerOf(bearer(token))).toBeNull();
    users.setDisabled(user.id, false);
    expect(callerOf(bearer(token))).toMatchObject({ kind: "user" });
  });

  it("an ended browser session stops working on the next request", () => {
    const session = createUserSession(sessionSecret(), admin, sessionTtl()).value;
    const withCookie = () => request({ cookie: `${SESSION_COOKIE}=${encodeURIComponent(session)}` });
    expect(callerOf(withCookie())).toMatchObject({ kind: "user", via: "session" });
    revokeSession(session, sessionExpiry(session));
    expect(callerOf(withCookie())).toBeNull();
  });

  it("a settings change applies to the next read", () => {
    const caller = { kind: "user" as const, user: admin, via: "token" as const };
    withCaller(caller, () => {
      const before = historySettings().limit;
      patchSettings({ "history.limit": before + 7 });
      expect(historySettings().limit).toBe(before + 7);
      patchSettings({ "history.limit": null });
      expect(historySettings().limit).toBe(before);
    });
  });

  it("a write from another process (the command-line tools) is seen too", () => {
    const { token } = users.createToken(admin.id, "outside");
    expect(callerOf(bearer(token))).toMatchObject({ kind: "user" });
    const before = changeStamp();
    const other = new Database(file);
    try {
      other.prepare("update users set disabled = 1 where id = ?").run(admin.id);
    } finally {
      other.close();
    }
    expect(changeStamp()).not.toBe(before);
    expect(callerOf(bearer(token))).toBeNull();
  });
});
