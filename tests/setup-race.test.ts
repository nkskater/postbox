/** First-administrator setup must be atomic (LAB-136). */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATABASE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "postbox-setup-race-")), "s.db");
delete process.env.POSTBOX_PASSWORD;
delete process.env.POSTBOX_TOKEN;

const { POST } = await import("@/app/api/auth/setup/route");
const { getDb, schema } = await import("@/server/db");
const users = await import("@/server/users");

const setup = (username: string) =>
  POST(
    new Request("http://localhost/api/auth/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password: "password123" }),
    }),
  );

describe("first-administrator setup", () => {
  it("creates exactly one administrator when requests race", async () => {
    const results = await Promise.all(["alice", "bob", "carol"].map(setup));
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    const all = getDb().select().from(schema.users).all();
    expect(all).toHaveLength(1);
    expect(all[0].isAdmin).toBe(true);
    // Losers leave nothing behind: one private workspace, owned by the winner.
    const members = getDb().select().from(schema.workspaceMembers).all();
    expect(new Set(members.map((m) => m.userId))).toEqual(new Set([all[0].id]));
    expect(results.filter((r) => r.status === 409).every((r) => !r.headers.get("set-cookie"))).toBe(true);
  });

  it("still lets ordinary user creation add accounts afterwards", async () => {
    const u = await users.createUser({ username: "dave", password: "password123" });
    expect(u.isAdmin).toBe(false);
    expect((await setup("erin")).status).toBe(409);
  });
});
