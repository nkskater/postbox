/**
 * Statements prepared per API request. The fixed lookups (caller, settings, workspace access)
 * are prepared once and cached (src/server/db-cache.ts); these bounds keep it that way.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { NextRequest } from "next/server";
import type { Caller } from "@/server/caller";
import type { UserRow } from "@/server/db/schema";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-statements-"));
process.env.DATABASE_PATH = path.join(dir, "test.db");
const { getSqlite } = await import("@/server/db");
const users = await import("@/server/users");
const repo = await import("@/server/repo");
const { withCaller } = await import("@/server/access-context");
const treeRoute = await import("@/app/api/workspaces/[id]/tree/route");
const proxyRoute = await import("@/app/api/proxy/route");
const { proxy } = await import("@/proxy");

let owner: UserRow;
let token: string;
let workspaceId: string;
let server: http.Server;
let target: string;

/** SQL prepared while `fn` runs. */
async function statements(fn: () => Promise<unknown>): Promise<string[]> {
  const sqlite = getSqlite();
  const original = sqlite.prepare;
  const seen: string[] = [];
  sqlite.prepare = function (this: typeof sqlite, source: string) {
    seen.push(source);
    return original.call(this, source);
  } as typeof sqlite.prepare;
  try {
    await fn();
  } finally {
    sqlite.prepare = original;
  }
  return seen;
}

const auth = () => ({ authorization: `Bearer ${token}` });

beforeAll(async () => {
  owner = await users.createUser({ username: "owner", password: "password123", isAdmin: true });
  token = users.createToken(owner.id, "statements").token;
  const caller: Caller = { kind: "user", user: owner, via: "token" };
  workspaceId = withCaller(caller, () => {
    const ws = repo.createWorkspace("Counted");
    const folder = repo.createFolder(ws.id, null);
    for (let i = 0; i < 50; i++)
      repo.createRequest(ws.id, folder.id, { name: `r${i}`, url: `http://x/${i}` });
    return ws.id;
  });
  server = http.createServer((_req, res) => res.end("ok"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  target = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});

afterAll(() => {
  server?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const tree = () =>
  treeRoute.GET(new Request(`http://localhost/api/workspaces/${workspaceId}/tree`, { headers: auth() }), {
    params: Promise.resolve({ id: workspaceId }),
  });

const send = () =>
  proxyRoute.POST(
    new Request("http://localhost/api/proxy", {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ workspaceId, request: { method: "GET", url: target } }),
    }),
  );

describe("statements prepared per request", () => {
  it("tree listing with an API key", async () => {
    expect((await tree()).status).toBe(200);
    const seen = await statements(async () => expect((await tree()).status).toBe(200));
    expect(seen.length, seen.join("\n")).toBeLessThanOrEqual(2);
  });

  it("request gate plus tree listing", async () => {
    const seen = await statements(async () => {
      proxy(new NextRequest(`http://localhost/api/workspaces/${workspaceId}/tree`, { headers: auth() }));
      expect((await tree()).status).toBe(200);
    });
    expect(seen.length, seen.join("\n")).toBeLessThanOrEqual(2);
  });

  it("send without scripts", async () => {
    expect((await send()).status).toBe(200);
    const seen = await statements(async () => expect((await send()).status).toBe(200));
    expect(seen.length, seen.join("\n")).toBeLessThanOrEqual(9);
  });
});
