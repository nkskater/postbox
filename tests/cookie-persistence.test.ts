import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CookieJarStore } from "@/core/http/cookies";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-cookies-"));
process.env.DATABASE_PATH = path.join(dir, "test.db");
let repo: typeof import("@/server/repo");
let context: typeof import("@/server/context");
let runs: typeof import("@/server/runs");
let db: typeof import("@/server/db");
let server: http.Server;
let url: string;
const pending = new Map<string, http.ServerResponse>();
let arrived: (() => void) | undefined;

beforeAll(async () => {
  repo = await import("@/server/repo");
  context = await import("@/server/context");
  runs = await import("@/server/runs");
  db = await import("@/server/db");
  server = http.createServer((req, res) => {
    pending.set(req.url!, res);
    arrived?.();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.getSqlite().close();
  fs.rmSync(dir, { recursive: true, force: true });
});
async function waitFor(...names: string[]) {
  if (names.every((name) => pending.has(name))) return;
  await new Promise<void>((resolve) => {
    arrived = () => {
      if (names.every((name) => pending.has(name))) {
        arrived = undefined;
        resolve();
      }
    };
  });
}
function respond(name: string, cookies: string[] = []) {
  const res = pending.get(name)!;
  pending.delete(name);
  res.writeHead(200, { "Set-Cookie": cookies });
  res.end("ok");
}
async function seed(workspaceId: string, headers: string[]) {
  const jar = new CookieJarStore();
  await jar.storeSetCookies(headers, url);
  repo.saveCookies(workspaceId, jar.getChanges());
}
function fixture(name: string) {
  const ws = repo.createWorkspace(name);
  const folder = repo.createFolder(ws.id, null);
  const request = repo.createRequest(ws.id, folder.id, { url: url + "/" + name });
  return { workspaceId: ws.id, folderId: folder.id, environmentId: null, request };
}

describe("cookie delta persistence", () => {
  it("preserves concurrent single-request and collection-run additions and UI deletions", async () => {
    const input = fixture("single");
    await seed(input.workspaceId, ["removed=old; Path=/", "stable=old; Path=/"]);
    const stableId = repo.listCookies(input.workspaceId).find((c) => c.name === "stable")!.id;
    const folder = repo.createFolder(input.workspaceId, null);
    repo.createRequest(input.workspaceId, folder.id, { url: url + "/run" });
    const single = context.runSingleRequest(input);
    const run = runs.startRun({ ...input, folderId: folder.id });
    await waitFor("/single", "/run");
    repo.deleteCookie(repo.listCookies(input.workspaceId).find((c) => c.name === "removed")!.id);
    respond("/single", ["single=one; Path=/"]);
    await single;
    respond("/run", ["run=two; Path=/"]);
    await run;
    expect(
      repo
        .listCookies(input.workspaceId)
        .map((c) => c.name)
        .sort(),
    ).toEqual(["run", "single", "stable"]);
    expect(repo.listCookies(input.workspaceId).find((c) => c.name === "stable")!.id).toBe(stableId);
  });

  it("does not resurrect cleared cookies or erase concurrent additions on explicit expiry", async () => {
    const input = fixture("expiry");
    await seed(input.workspaceId, ["old=value; Path=/", "delete=value; Path=/"]);
    const stale = new CookieJarStore(repo.listCookies(input.workspaceId));
    repo.clearCookies(input.workspaceId);
    await seed(input.workspaceId, ["new=value; Path=/", "delete=updated; Path=/"]);
    await stale.storeSetCookies(["delete=; Max-Age=0; Path=/"], url);
    repo.saveCookies(input.workspaceId, stale.getChanges());
    expect(repo.listCookies(input.workspaceId).map((c) => c.name)).toEqual(["new"]);
  });

  it("persists Max-Age deadlines and excludes read-driven expiry from mutations", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const input = fixture("ttl");
      const jar = new CookieJarStore();
      await jar.storeSetCookies(["short=value; Max-Age=2; Path=/"], url);
      repo.saveCookies(input.workspaceId, jar.getChanges());
      expect(repo.listCookies(input.workspaceId)[0].expires).toBe(Date.now() + 2000);
      const stale = new CookieJarStore(repo.listCookies(input.workspaceId));
      vi.setSystemTime(Date.now() + 3000);
      expect(await stale.getCookieHeader(url)).toBe("");
      await seed(input.workspaceId, ["short=fresh; Path=/"]);
      repo.saveCookies(input.workspaceId, stale.getChanges());
      expect(repo.listCookies(input.workspaceId)[0].value).toBe("fresh");
      expect(jar.getChanges().deletions).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("tracks explicit removals and clear without deleting unseen concurrent cookies", async () => {
    const input = fixture("clear");
    await seed(input.workspaceId, ["a=1; Path=/", "b=2; Path=/"]);
    const jar = new CookieJarStore(repo.listCookies(input.workspaceId));
    await jar.remove("127.0.0.1", "/", "a");
    await jar.clear();
    await seed(input.workspaceId, ["c=3; Path=/"]);
    repo.saveCookies(input.workspaceId, jar.getChanges());
    expect(repo.listCookies(input.workspaceId).map((c) => c.name)).toEqual(["c"]);
  });

  it("uses the last explicit mutation for a cookie and preserves IDs on updates", async () => {
    const input = fixture("updates");
    await seed(input.workspaceId, ["key=original; Path=/"]);
    const id = repo.listCookies(input.workspaceId)[0].id;
    const jar = new CookieJarStore(repo.listCookies(input.workspaceId));
    await jar.storeSetCookies(
      ["key=; Max-Age=0; Path=/", "key=updated; Path=/", "bad=x; Domain=other.test"],
      url,
    );
    repo.saveCookies(input.workspaceId, jar.getChanges());
    expect(repo.listCookies(input.workspaceId)).toMatchObject([{ id, name: "key", value: "updated" }]);
    await jar.storeSetCookies(["key=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/"], url);
    repo.saveCookies(input.workspaceId, jar.getChanges());
    expect(repo.listCookies(input.workspaceId)).toEqual([]);
  });

  it("isolates workspaces and rolls back the entire delta on a failed write", async () => {
    const a = fixture("atomic-a"),
      b = fixture("atomic-b");
    await seed(a.workspaceId, ["keep=1; Path=/"]);
    await seed(b.workspaceId, ["keep=2; Path=/"]);
    const jar = new CookieJarStore(repo.listCookies(a.workspaceId));
    await jar.clear();
    await jar.storeSetCookies(["invalid=1; Path=/"], url);
    const changes = jar.getChanges();
    // Exercise a real SQLite NOT NULL failure after the deletion in the transaction.
    changes.upserts[0].value = null as unknown as string;
    expect(() => repo.saveCookies(a.workspaceId, changes)).toThrow();
    expect(repo.listCookies(a.workspaceId)[0].value).toBe("1");
    expect(repo.listCookies(b.workspaceId)[0].value).toBe("2");
  });
});
