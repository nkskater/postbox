import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
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
let inFlight = 0;
let maxInFlight = 0;

beforeAll(async () => {
  repo = await import("@/server/repo");
  runs = await import("@/server/runs");
  db = await import("@/server/db");
  server = http.createServer((_req, res) => {
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
});
