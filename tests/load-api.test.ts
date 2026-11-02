import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Caller } from "@/server/caller";
import type { UserRow } from "@/server/db/schema";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-load-api-"));
process.env.DATABASE_PATH = path.join(dir, "db.sqlite");
process.env.LOAD_MAX_VUS = "8";
process.env.LOAD_MAX_DURATION_SEC = "20";
const users = await import("@/server/users");
const repo = await import("@/server/repo");
const { withCaller } = await import("@/server/access-context");
const { setMember } = await import("@/server/authorize");
const { getSqlite } = await import("@/server/db");
const { WEBHOOK_EVENTS } = await import("@/core/webhook-events");
const listRoute = await import("@/app/api/load-runs/route");
const oneRoute = await import("@/app/api/load-runs/[id]/route");
const cancelRoute = await import("@/app/api/load-runs/[id]/cancel/route");
const exportRoute = await import("@/app/api/load-runs/[id]/export/route");
const compareRoute = await import("@/app/api/load-runs/compare/route");

let owner: UserRow, viewer: UserRow, outsider: UserRow;
const keys: Record<string, string> = {};
let workspaceId = "";
let folderId = "";
let origin: http.Server;
let originUrl = "";
let hits = 0;

const caller = (user: UserRow): Caller => ({ kind: "user", user, via: "token" });
type Handler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response> | Response;
const call = (
  handler: unknown,
  user: UserRow,
  url: string,
  init: { method?: string; body?: unknown; id?: string } = {},
) =>
  (handler as Handler)(
    new Request(`http://localhost${url}`, {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${keys[user.id]}`,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
    { params: Promise.resolve({ id: init.id ?? "" }) },
  );
const json = async (res: Response) => {
  const text = await res.text();
  return text ? JSON.parse(text) : undefined;
};
const ndjson = async (res: Response) =>
  (await res.text())
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l)) as { type: string; runId?: string; [k: string]: unknown }[];

const start = (user: UserRow, body: Record<string, unknown>) =>
  call(listRoute.POST, user, "/api/load-runs", {
    method: "POST",
    body: { workspaceId, folderId, profile: { type: "constant", vus: 2, durationSec: 1 }, ...body },
  });

beforeAll(async () => {
  origin = http.createServer((req, res) => {
    hits++;
    setTimeout(() => {
      res.writeHead(req.url === "/fail" ? 500 : 200);
      res.end("ok");
    }, 10);
  });
  await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
  originUrl = `http://127.0.0.1:${(origin.address() as AddressInfo).port}`;
  owner = await users.createUser({ username: "owner", password: "password123" });
  viewer = await users.createUser({ username: "viewer", password: "password123" });
  outsider = await users.createUser({ username: "outsider", password: "password123" });
  for (const user of [owner, viewer, outsider]) keys[user.id] = users.createToken(user.id, "t").token;
  withCaller(caller(owner), () => {
    workspaceId = repo.createWorkspace("Load").id;
    setMember(workspaceId, viewer.username, "viewer");
    const folder = repo.createFolder(workspaceId, null, { name: "Shop" });
    folderId = folder.id;
    repo.createRequest(workspaceId, folder.id, { name: "Home", method: "GET", url: `${originUrl}/home` });
    repo.createRequest(workspaceId, folder.id, { name: "Broken", method: "GET", url: `${originUrl}/fail` });
  });
});
afterAll(() => {
  origin.close();
  getSqlite().close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("load test API", () => {
  it("streams events, stores the result and lists headline numbers", async () => {
    const res = await start(owner, {
      thresholds: [
        { metric: "p95", op: "<", value: 5000 },
        { metric: "errorRate", op: "<", value: 0.9, request: "Broken" },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("ndjson");
    const events = await ndjson(res);
    expect(events[0].type).toBe("start");
    expect(events.at(-1)!.type).toBe("done");
    const runId = events[0].runId!;
    const run = await json(await call(oneRoute.GET, owner, `/api/load-runs/${runId}`, { id: runId }));
    expect(run).toMatchObject({ status: "failed", name: "Shop", profile: { type: "constant", vus: 2 } });
    expect(run.result.snapshot.requests).toBeGreaterThan(5);
    expect(run.result.snapshot.byRequest.map((r: { name: string }) => r.name).sort()).toEqual([
      "Broken",
      "Home",
    ]);
    expect(run.result.snapshot.statuses["500"]).toBeGreaterThan(0);
    expect(run.result.thresholds.map((t: { passed: boolean }) => t.passed)).toEqual([true, false]);
    expect(hits).toBeGreaterThanOrEqual(run.result.snapshot.requests);

    const listed = await json(await call(listRoute.GET, owner, `/api/load-runs?workspaceId=${workspaceId}`));
    expect(listed[0]).toMatchObject({
      id: runId,
      status: "failed",
      summary: { requests: run.result.snapshot.requests, thresholdsFailed: 1 },
    });
    expect(listed[0]).not.toHaveProperty("result");
  }, 30000);

  it("enforces roles: viewers read, only people who can run may start or cancel, outsiders see nothing", async () => {
    const ok = await ndjson(await start(owner, {}));
    const runId = ok[0].runId!;
    expect((await start(viewer, {})).status).toBe(403);
    expect((await start(outsider, {})).status).toBe(404);
    expect((await call(oneRoute.GET, viewer, `/api/load-runs/${runId}`, { id: runId })).status).toBe(200);
    expect((await call(oneRoute.GET, outsider, `/api/load-runs/${runId}`, { id: runId })).status).toBe(404);
    expect((await call(listRoute.GET, outsider, `/api/load-runs?workspaceId=${workspaceId}`)).status).toBe(
      404,
    );
    expect(
      (await call(oneRoute.DELETE, viewer, `/api/load-runs/${runId}`, { method: "DELETE", id: runId }))
        .status,
    ).toBe(403);
    expect(
      (await call(cancelRoute.POST, viewer, `/api/load-runs/${runId}/cancel`, { method: "POST", id: runId }))
        .status,
    ).toBe(403);
    expect(
      (await call(exportRoute.GET, viewer, `/api/load-runs/${runId}/export?format=csv`, { id: runId }))
        .status,
    ).toBe(200);
    expect(
      (await call(exportRoute.GET, outsider, `/api/load-runs/${runId}/export`, { id: runId })).status,
    ).toBe(404);
    expect(
      (
        await call(
          compareRoute.GET,
          outsider,
          `/api/load-runs/compare?workspaceId=${workspaceId}&base=${runId}&head=${runId}`,
        )
      ).status,
    ).toBe(404);
  }, 30000);

  it("refuses profiles beyond the server ceilings before starting anything", async () => {
    const before = hits;
    const tooMany = await start(owner, { profile: { type: "constant", vus: 9, durationSec: 1 } });
    expect(tooMany.status).toBe(400);
    expect((await json(tooMany)).error).toMatch(/limit is 8/);
    const tooLong = await start(owner, { profile: { type: "constant", vus: 1, durationSec: 21 } });
    expect(tooLong.status).toBe(400);
    expect((await json(tooLong)).error).toMatch(/limit is 20 s/);
    expect((await start(owner, { profile: { type: "constant", vus: 0, durationSec: 1 } })).status).toBe(400);
    expect((await start(owner, { thresholds: [{ metric: "bogus", op: "<", value: 1 }] })).status).toBe(400);
    expect((await start(owner, { folderId: "missing" })).status).toBe(404);
    expect(hits).toBe(before);
  });

  it("cancels a running test and keeps the numbers so far", async () => {
    const res = await start(owner, { profile: { type: "constant", vus: 2, durationSec: 20 } });
    const reading = ndjson(res);
    let runId = "";
    for (let i = 0; i < 50 && !runId; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const list = await json(await call(listRoute.GET, owner, `/api/load-runs?workspaceId=${workspaceId}`));
      runId = list.find((r: { status: string }) => r.status === "running")?.id ?? "";
    }
    expect(runId).not.toBe("");
    // A running test cannot be deleted.
    expect(
      (await call(oneRoute.DELETE, owner, `/api/load-runs/${runId}`, { method: "DELETE", id: runId })).status,
    ).toBe(409);
    await new Promise((r) => setTimeout(r, 700));
    const cancelled = await json(
      await call(cancelRoute.POST, owner, `/api/load-runs/${runId}/cancel`, { method: "POST", id: runId }),
    );
    expect(cancelled).toEqual({ cancelled: true });
    const events = await reading;
    expect(events.at(-1)).toMatchObject({ type: "done", result: { status: "cancelled" } });
    const run = await json(await call(oneRoute.GET, owner, `/api/load-runs/${runId}`, { id: runId }));
    expect(run.status).toBe("cancelled");
    expect(run.result.stoppedBy).toBe("cancelled");
    expect(run.result.snapshot.requests).toBeGreaterThan(0);
    expect(
      (await call(oneRoute.DELETE, owner, `/api/load-runs/${runId}`, { method: "DELETE", id: runId })).status,
    ).toBe(200);
    expect((await call(oneRoute.GET, owner, `/api/load-runs/${runId}`, { id: runId })).status).toBe(404);
  }, 30000);

  it("queues behind the shared run limit and answers 429 when the queue is full", async () => {
    const original = { a: process.env.RUNS_MAX_ACTIVE, q: process.env.RUNS_MAX_QUEUED };
    process.env.RUNS_MAX_ACTIVE = "1";
    process.env.RUNS_MAX_QUEUED = "0";
    try {
      const first = start(owner, { profile: { type: "constant", vus: 1, durationSec: 2 } });
      const firstRes = await first;
      const second = await start(owner, {});
      expect(second.status).toBe(429);
      expect((await json(second)).error).toMatch(/queue is full/i);
      expect((await ndjson(firstRes)).at(-1)!.type).toBe("done");
    } finally {
      if (original.a === undefined) delete process.env.RUNS_MAX_ACTIVE;
      else process.env.RUNS_MAX_ACTIVE = original.a;
      if (original.q === undefined) delete process.env.RUNS_MAX_QUEUED;
      else process.env.RUNS_MAX_QUEUED = original.q;
    }
  }, 30000);

  it("exports JSON, CSV and JUnit reports and compares two tests", async () => {
    const run = async () =>
      (await ndjson(await start(owner, { thresholds: [{ metric: "p95", op: "<", value: 5000 }] })))[0].runId!;
    const a = await run();
    const b = await run();
    const get = (id: string, format: string) =>
      call(exportRoute.GET, owner, `/api/load-runs/${id}/export?format=${format}`, { id });
    const csv = await (await get(a, "csv")).text();
    expect(csv).toContain("section,name,value");
    expect(csv).toContain("latency_ms,p95,");
    expect(csv).toContain("request,requests,errors");
    expect(csv).toContain("t_seconds,requests,errors,rps,p50_ms,p95_ms,vus");
    const junit = await (await get(a, "junit")).text();
    expect(junit).toContain('<testsuite name="Shop (2 VUs for 1 s)" tests="1" failures="0"');
    const asJson = JSON.parse(await (await get(a, "json")).text());
    expect(asJson).toMatchObject({ id: a, name: "Shop", status: "passed" });
    const bad = await get(a, "xml");
    expect(bad.status).toBe(400);

    const compared = await json(
      await call(
        compareRoute.GET,
        owner,
        `/api/load-runs/compare?workspaceId=${workspaceId}&base=${a}&head=${b}`,
      ),
    );
    expect(compared.base.id).toBe(a);
    expect(compared.metrics.p95).toEqual({
      before: expect.any(Number),
      after: expect.any(Number),
      delta: expect.any(Number),
      percent: expect.anything(),
    });
    expect(compared.byRequest.map((r: { name: string }) => r.name).sort()).toEqual(["Broken", "Home"]);
  }, 60000);

  it("announces load events to webhooks", () => {
    expect(WEBHOOK_EVENTS.map((e) => e.type)).toEqual(
      expect.arrayContaining(["load.passed", "load.failed", "load.cancelled", "load.error"]),
    );
  });
});
