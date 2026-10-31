import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { getEventListeners } from "node:events";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { RunQueue, RunQueueFullError } from "@/server/run-queue";
import type { StartRunEvent } from "@/server/runs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-run-queue-"));
process.env.DATABASE_PATH = path.join(dir, "test.db");
process.env.RUNS_MAX_ACTIVE = "1";
process.env.RUNS_MAX_QUEUED = "1";

let repo: typeof import("@/server/repo");
let runs: typeof import("@/server/runs");
let db: typeof import("@/server/db");
let server: http.Server;
let base = "";
let hits = 0;
const urls: string[] = [];
let inFlight = 0;
let maxInFlight = 0;

beforeAll(async () => {
  repo = await import("@/server/repo");
  runs = await import("@/server/runs");
  db = await import("@/server/db");
  server = http.createServer((req, res) => {
    urls.push(req.url!);
    hits++;
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    setTimeout(() => {
      inFlight--;
      res.end("ok");
    }, 150);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.getSqlite().close();
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.RUNS_MAX_ACTIVE;
  delete process.env.RUNS_MAX_QUEUED;
});

function collection() {
  const ws = repo.createWorkspace("Queued");
  const folder = repo.createFolder(ws.id, null, { name: "Collection" });
  repo.createRequest(ws.id, folder.id, { url: base + "/" });
  return { workspaceId: ws.id, folderId: folder.id, environmentId: null };
}

describe("RunQueue", () => {
  it("admits up to maxActive, queues FIFO and rejects beyond maxQueued", async () => {
    const q = new RunQueue(() => ({ maxActive: 1, maxQueued: 2 }));
    const a = q.reserve();
    const b = q.reserve();
    const c = q.reserve();
    expect([a.position, b.position, c.position]).toEqual([0, 1, 2]);
    expect(() => q.reserve()).toThrow(RunQueueFullError);
    const order: string[] = [];
    void b.ready.then(() => order.push("b"));
    void c.ready.then(() => order.push("c"));
    a.release();
    await b.ready;
    expect(q.stats()).toMatchObject({ active: 1, queued: 1 });
    b.release();
    await c.ready;
    expect(order).toEqual(["b", "c"]);
    c.release();
    c.release();
    expect(q.stats()).toMatchObject({ active: 0, queued: 0 });
  });

  it("removes cancelled waiters without admitting them", async () => {
    const q = new RunQueue(() => ({ maxActive: 1, maxQueued: 5 }));
    const a = q.reserve();
    const b = q.reserve();
    const c = q.reserve();
    b.cancel();
    await expect(b.ready).rejects.toThrow(/cancelled/);
    a.release();
    await c.ready;
    expect(q.stats()).toMatchObject({ active: 1, queued: 0 });
  });

  it("uses a 429 status when full", () => {
    const q = new RunQueue(() => ({ maxActive: 0, maxQueued: 0 }));
    try {
      q.reserve();
      expect.unreachable();
    } catch (err) {
      expect((err as RunQueueFullError).status).toBe(429);
    }
  });
});

describe("queued collection runs", () => {
  it("never exceeds the active limit and rejects when the queue is full", async () => {
    maxInFlight = 0;
    const events: StartRunEvent[] = [];
    const first = runs.startRun({ ...collection(), options: { iterations: 2 } });
    const second = runs.startRun({ ...collection(), onEvent: (e) => events.push(e) });
    await expect(runs.startRun(collection())).rejects.toBeInstanceOf(RunQueueFullError);
    const [a, b] = await Promise.all([first, second]);
    expect(a.summary.status).toBe("passed");
    expect(b.summary.status).toBe("passed");
    expect(maxInFlight).toBe(1);
    expect(events[0]).toMatchObject({ type: "queued", position: 1 });
    expect(events.at(-1)?.type).toBe("done");
    expect(runs.runQueue.stats()).toMatchObject({ active: 0, queued: 0 });
  });

  it("cancels a queued run without sending any request", async () => {
    const before = hits;
    const first = runs.startRun(collection());
    const events: StartRunEvent[] = [];
    let queuedId = "";
    const second = runs.startRun({
      ...collection(),
      onEvent: (e) => {
        events.push(e);
        if (e.type === "queued") queuedId = e.runId;
      },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(runs.getRunSummary(queuedId)?.status).toBe("queued");
    expect(runs.cancelRun(queuedId)).toBe(true);
    const { summary } = await second;
    await first;
    expect(summary).toMatchObject({ status: "cancelled", totalRequests: 0 });
    expect(hits - before).toBe(1);
    expect(events.map((e) => e.type)).toEqual(["queued", "done"]);
    expect(runs.getRunSummary(queuedId)?.status).toBe("cancelled");
  });

  it("returns 429 from the REST API when the queue is full", async () => {
    const { POST } = await import("@/app/api/runs/route");
    const first = runs.startRun(collection());
    const second = runs.startRun(collection());
    const res = await POST(
      new Request("http://localhost/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(collection()),
      }),
    );
    expect(res.status).toBe(429);
    expect((await res.json()).error).toMatch(/queue is full/);
    await Promise.all([first, second]);
  });
  it("loads the tree, ancestors, scopes and cookies only after admission, using refreshed data", async () => {
    const input = collection();
    const existing = repo.getFolderTree(input.folderId)!.children[0];
    const context = await import("@/server/context");
    const tree = vi.spyOn(repo, "getFolderTree");
    const chain = vi.spyOn(repo, "getFolderChain");
    const scopes = vi.spyOn(context, "loadScopes");
    const cookies = vi.spyOn(repo, "listCookies");
    const blocker = runs.reserveRun();
    const result = runs.startRun(input);
    try {
      expect(runs.runQueue.stats()).toMatchObject({ active: 1, queued: 1 });
      for (const spy of [tree, chain, scopes, cookies]) expect(spy).not.toHaveBeenCalled();
      repo.updateFolder(input.folderId, { name: "Refreshed collection" });
      repo.updateRequest(existing.id, { url: `${base}/{{fresh}}` });
      repo.persistScopeDiff(input.workspaceId, "global", null, {}, { fresh: "refreshed" });
      blocker.release();
      const { runId, summary } = await result;
      expect(summary).toMatchObject({ name: "Refreshed collection", status: "passed" });
      expect(runs.getRunSummary(runId)?.name).toBe("Refreshed collection");
      expect(urls.at(-1)).toBe("/refreshed");
      for (const spy of [tree, chain, scopes, cookies]) expect(spy).toHaveBeenCalledOnce();
      expect(runs.runQueue.stats()).toMatchObject({ active: 0, queued: 0 });
    } finally {
      blocker.release();
      await result.catch(() => undefined);
    }
  });

  it("cancels a waiting run without loading execution data", async () => {
    const input = collection();
    const context = await import("@/server/context");
    const tree = vi.spyOn(repo, "getFolderTree");
    const scopes = vi.spyOn(context, "loadScopes");
    const cookies = vi.spyOn(repo, "listCookies");
    const blocker = runs.reserveRun();
    const controller = new AbortController();
    const result = runs.startRun({ ...input, signal: controller.signal });
    try {
      controller.abort();
      expect((await result).summary).toMatchObject({ status: "cancelled", totalRequests: 0 });
      for (const spy of [tree, scopes, cookies]) expect(spy).not.toHaveBeenCalled();
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
      expect(runs.runQueue.stats()).toMatchObject({ active: 1, queued: 0 });
    } finally {
      blocker.release();
      await result.catch(() => undefined);
    }
  });

  it("releases a reservation exactly once if the initial database insert fails", async () => {
    const input = collection();
    const ticket = runs.reserveRun();
    const release = vi.spyOn(ticket, "release");
    const controller = new AbortController();
    db.getSqlite().exec(
      "CREATE TRIGGER reject_run_insert BEFORE INSERT ON runs BEGIN SELECT RAISE(ABORT, 'run insert failed'); END;",
    );
    try {
      await expect(runs.startRun({ ...input, ticket, signal: controller.signal })).rejects.toThrow(
        "run insert failed",
      );
      expect(release).toHaveBeenCalledOnce();
      expect(runs.runQueue.stats()).toMatchObject({ active: 0, queued: 0 });
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    } finally {
      db.getSqlite().exec("DROP TRIGGER reject_run_insert");
      ticket.cancel();
    }
    expect((await runs.startRun(input)).summary.status).toBe("passed");
  });

  it("releases queued reservations and cancellation handles when the queued observer throws", async () => {
    const input = collection();
    const blocker = runs.reserveRun();
    const ticket = runs.reserveRun();
    const release = vi.spyOn(ticket, "release");
    const signal = new AbortController().signal;
    let id = "";
    try {
      await expect(
        runs.startRun({
          ...input,
          ticket,
          signal,
          onEvent: (event) => {
            id = event.runId;
            throw new Error("observer failed");
          },
        }),
      ).rejects.toThrow("observer failed");
      expect(release).toHaveBeenCalledOnce();
      expect(runs.getRunSummary(id)).toMatchObject({ status: "error", error: "observer failed" });
      expect(runs.cancelRun(id)).toBe(false);
      expect(getEventListeners(signal, "abort")).toHaveLength(0);
      expect(runs.runQueue.stats()).toMatchObject({ active: 1, queued: 0 });
    } finally {
      blocker.release();
      ticket.cancel();
    }
  });

  it("releases an admitted reservation exactly once if execution data cannot load", async () => {
    const input = collection();
    const blocker = runs.reserveRun();
    const ticket = runs.reserveRun();
    const release = vi.spyOn(ticket, "release");
    const tree = vi.spyOn(repo, "getFolderTree").mockImplementationOnce(() => {
      throw new Error("tree unavailable");
    });
    let id = "";
    const result = runs.startRun({
      ...input,
      ticket,
      onEvent: (event) => {
        id = event.runId;
      },
    });
    try {
      expect(tree).not.toHaveBeenCalled();
      blocker.release();
      await expect(result).rejects.toThrow("tree unavailable");
      expect(tree).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledOnce();
      expect(runs.getRunSummary(id)).toMatchObject({ status: "error", error: "tree unavailable" });
      expect(runs.cancelRun(id)).toBe(false);
      expect(runs.runQueue.stats()).toMatchObject({ active: 0, queued: 0 });
    } finally {
      blocker.release();
      ticket.cancel();
      await result.catch(() => undefined);
    }
  });
  it("returns a caller-provided reservation if reference validation fails", async () => {
    const input = collection();
    const ticket = runs.reserveRun();
    const release = vi.spyOn(ticket, "release");
    try {
      await expect(runs.startRun({ ...input, folderId: "missing", ticket })).rejects.toThrow(
        /Folder not found/,
      );
      expect(release).toHaveBeenCalledOnce();
      expect(runs.runQueue.stats()).toMatchObject({ active: 0, queued: 0 });
    } finally {
      ticket.cancel();
    }
  });
  it("keeps queued status and cancellation handles shared across independently loaded route modules", async () => {
    const input = collection();
    const blocker = runs.reserveRun();
    let id = "";
    const result = runs.startRun({
      ...input,
      onEvent: (event) => {
        id = event.runId;
      },
    });
    try {
      vi.resetModules();
      const anotherBundle = await import("@/server/runs");
      expect(anotherBundle.listRuns(input.workspaceId)[0].status).toBe("queued");
      expect(anotherBundle.cancelRun(id)).toBe(true);
      expect((await result).summary.status).toBe("cancelled");
      expect(anotherBundle.cancelRun(id)).toBe(false);
    } finally {
      runs.cancelRun(id);
      blocker.release();
      await result.catch(() => undefined);
    }
  });
});
