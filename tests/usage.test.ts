import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startTestServer, type TestServer } from "./helpers/server";
import type { UserRow } from "@/server/db/schema";
import type { Caller } from "@/server/caller";
import { checkLimit, periodEnd, periodStart, usageToCsv } from "@/core/usage";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-usage-"));
process.env.DATABASE_PATH = path.join(dir, "db.sqlite");
const users = await import("@/server/users");
const repo = await import("@/server/repo");
const runs = await import("@/server/runs");
const usage = await import("@/server/usage");
const { withCaller } = await import("@/server/access-context");
const { setMember } = await import("@/server/authorize");
const { getSqlite } = await import("@/server/db");
const { queryAudit } = await import("@/server/audit");
const proxyRoute = await import("@/app/api/proxy/route");
const adminUsage = await import("@/app/api/admin/usage/route");
const limitsRoute = await import("@/app/api/admin/usage/limits/route");
const limitRoute = await import("@/app/api/admin/usage/limits/[id]/route");
const reconcileRoute = await import("@/app/api/admin/usage/reconcile/route");
const workspaceUsage = await import("@/app/api/workspaces/[id]/usage/route");

let server: TestServer;
let admin: UserRow, owner: UserRow, other: UserRow;
const keys: Record<string, string> = {};
const caller = (u: UserRow): Caller => ({ kind: "user", user: u, via: "token" });
const req = (
  method: string,
  url: string,
  user: UserRow,
  body?: unknown,
  headers: Record<string, string> = {},
) =>
  new Request("http://localhost" + url, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${keys[user.id]}`, ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

const newWorkspace = (name: string) => {
  const ws = withCaller(caller(owner), () => repo.createWorkspace(name));
  const folder = repo.createFolder(ws.id, null, { name: "Col" });
  repo.createRequest(ws.id, folder.id, { url: server.url + "/echo" });
  return { workspaceId: ws.id, folderId: folder.id, environmentId: null };
};
const send = (workspaceId: string, user: UserRow, headers: Record<string, string> = {}) =>
  proxyRoute.POST(
    req(
      "POST",
      "/api/proxy",
      user,
      { workspaceId, request: { method: "GET", url: server.url + "/echo" } },
      headers,
    ),
  );
const used = (workspaceId: string, metric: string) =>
  usage.workspaceUsage(workspaceId, 0, Date.now() + 86_400_000).find((l) => l.metric === metric)!.used;

beforeAll(async () => {
  server = await startTestServer();
  admin = await users.createUser({ username: "root", password: "password123", isAdmin: true });
  owner = await users.createUser({ username: "owner", password: "password123" });
  other = await users.createUser({ username: "other", password: "password123" });
  for (const u of [admin, owner, other]) keys[u.id] = users.createToken(u.id, "t").token;
});
afterAll(async () => {
  await server.close();
  getSqlite().close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("usage rules", () => {
  it("decides reservations from used, amount and limits", () => {
    expect(checkLimit({ used: 8, amount: 2, soft: null, hard: 10 })).toEqual({
      allowed: true,
      softExceeded: false,
      remaining: 0,
    });
    expect(checkLimit({ used: 9, amount: 2, soft: null, hard: 10 }).allowed).toBe(false);
    expect(checkLimit({ used: 5, amount: 1, soft: 5, hard: null })).toEqual({
      allowed: true,
      softExceeded: true,
      remaining: null,
    });
    expect(checkLimit({ used: 4, amount: 1, soft: 5, hard: null }).softExceeded).toBe(false);
  });

  it("uses UTC calendar periods", () => {
    const at = Date.UTC(2026, 11, 31, 23, 59, 59);
    expect(periodStart("day", at)).toBe(Date.UTC(2026, 11, 31));
    expect(periodEnd("day", at)).toBe(Date.UTC(2027, 0, 1));
    expect(periodStart("month", at)).toBe(Date.UTC(2026, 11, 1));
    expect(periodEnd("month", at)).toBe(Date.UTC(2027, 0, 1));
  });

  it("exports CSV that cannot run as a formula", () => {
    const csv = usageToCsv(0, 1000, [
      { workspaceId: "w", workspaceName: "=HYPERLINK(1)", metric: "requests", unit: "requests", used: 3 },
    ]);
    expect(csv.split("\r\n")[1]).toContain("'=HYPERLINK(1)");
  });
});

describe("accounting", () => {
  it("counts each request and each run once, with duration and request totals", async () => {
    const c = newWorkspace("Accounting");
    expect((await send(c.workspaceId, owner)).status).toBe(200);
    expect(used(c.workspaceId, "requests")).toBe(1);
    const { runId, summary } = await runs.startRun({ ...c, options: { iterations: 3 } });
    expect(used(c.workspaceId, "runs")).toBe(1);
    expect(used(c.workspaceId, "requests")).toBe(1 + summary.totalRequests);
    expect(used(c.workspaceId, "run_ms")).toBe(Math.round(summary.durationMs));
    expect(
      getSqlite().prepare("SELECT COUNT(*) AS n FROM usage_events WHERE idem_key = ?").get(`run:${runId}`),
    ).toEqual({ n: 1 });
  });

  it("counts a retry with the same Idempotency-Key once", async () => {
    const c = newWorkspace("Idempotent");
    await send(c.workspaceId, owner, { "idempotency-key": "order-42" });
    await send(c.workspaceId, owner, { "idempotency-key": "order-42" });
    await send(c.workspaceId, owner, { "idempotency-key": "order-43" });
    expect(used(c.workspaceId, "requests")).toBe(2);
    expect(
      usage.reserveUsage({ workspaceId: c.workspaceId, metric: "requests", key: "req:order-42" }),
    ).toEqual({ recorded: false, duplicate: true });
  });

  it("measures retained storage and reports it without a period", async () => {
    const c = newWorkspace("Storage");
    const before = usage.storageBytes(c.workspaceId);
    await send(c.workspaceId, owner);
    expect(usage.storageBytes(c.workspaceId)).toBeGreaterThan(before);
    expect(used(c.workspaceId, "storage_bytes")).toBe(usage.storageBytes(c.workspaceId));
  });
});

describe("quotas", () => {
  it("never refuses anything without limits", () => {
    const c = newWorkspace("No limits");
    for (let i = 0; i < 25; i++)
      usage.reserveUsage({ workspaceId: c.workspaceId, metric: "requests", enforce: true });
    expect(used(c.workspaceId, "requests")).toBe(25);
  });

  it("refuses requests past a hard limit with 429 and records an alert once", async () => {
    const c = newWorkspace("Hard");
    usage.setLimit({ workspaceId: c.workspaceId, metric: "requests", period: "day", hardLimit: 2 });
    expect((await send(c.workspaceId, owner)).status).toBe(200);
    expect((await send(c.workspaceId, owner)).status).toBe(200);
    const refused = await send(c.workspaceId, owner);
    expect(refused.status).toBe(429);
    expect(((await refused.json()) as { error: string }).error).toMatch(/Quota reached.*2 requests/);
    expect((await send(c.workspaceId, owner)).status).toBe(429);
    expect(used(c.workspaceId, "requests")).toBe(2);
    expect(usage.listAlerts({ workspaceId: c.workspaceId }).filter((a) => a.kind === "hard")).toHaveLength(1);
    expect(queryAudit({ action: "usage.hard_limit", workspaceId: c.workspaceId }).events).toHaveLength(1);
  });

  it("raises a soft alert once per period without refusing", () => {
    const c = newWorkspace("Soft");
    usage.setLimit({ workspaceId: c.workspaceId, metric: "requests", softLimit: 2, hardLimit: 100 });
    for (let i = 0; i < 5; i++)
      usage.reserveUsage({ workspaceId: c.workspaceId, metric: "requests", enforce: true });
    const alerts = usage.listAlerts({ workspaceId: c.workspaceId }).filter((a) => a.kind === "soft");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ metric: "requests", limitValue: 2, used: 3 });
  });

  it("applies a default to every workspace and lets a workspace override it", () => {
    const a = newWorkspace("Default A");
    const b = newWorkspace("Default B");
    usage.setLimit({ metric: "runs", hardLimit: 1 });
    usage.setLimit({ workspaceId: b.workspaceId, metric: "runs", hardLimit: 5 });
    usage.reserveUsage({ workspaceId: a.workspaceId, metric: "runs", enforce: true });
    expect(() => usage.reserveUsage({ workspaceId: a.workspaceId, metric: "runs", enforce: true })).toThrow(
      /Quota reached/,
    );
    for (let i = 0; i < 5; i++)
      usage.reserveUsage({ workspaceId: b.workspaceId, metric: "runs", enforce: true });
    expect(() => usage.reserveUsage({ workspaceId: b.workspaceId, metric: "runs", enforce: true })).toThrow(
      /Quota reached/,
    );
    for (const l of usage.listLimits().filter((l) => l.metric === "runs")) usage.deleteLimit(l.id);
  });

  it("caps one identity across every workspace", async () => {
    const a = newWorkspace("Identity A");
    const b = newWorkspace("Identity B");
    for (const c of [a, b]) withCaller(caller(owner), () => setMember(c.workspaceId, "other", "editor"));
    usage.setLimit({ userId: other.id, metric: "requests", period: "day", hardLimit: 3 });
    expect((await send(a.workspaceId, other)).status).toBe(200);
    expect((await send(b.workspaceId, other)).status).toBe(200);
    expect((await send(a.workspaceId, other)).status).toBe(200);
    expect((await send(b.workspaceId, other)).status).toBe(429);
    // Someone else in the same workspace is unaffected.
    expect((await send(b.workspaceId, owner)).status).toBe(200);
  });

  it("refuses a collection run when a run limit is reached, and stores nothing for it", async () => {
    const c = newWorkspace("Run limit");
    usage.setLimit({ workspaceId: c.workspaceId, metric: "runs", hardLimit: 1 });
    await runs.startRun(c);
    const before = getSqlite()
      .prepare("SELECT COUNT(*) AS n FROM runs WHERE workspace_id = ?")
      .get(c.workspaceId);
    await expect(runs.startRun(c)).rejects.toThrow(/Quota reached/);
    expect(
      getSqlite().prepare("SELECT COUNT(*) AS n FROM runs WHERE workspace_id = ?").get(c.workspaceId),
    ).toEqual(before);
    expect(runs.runQueue.stats().active).toBe(0);
  });

  it("refuses new work once retained storage is over a hard limit", async () => {
    const c = newWorkspace("Storage limit");
    await send(c.workspaceId, owner);
    usage.setLimit({ workspaceId: c.workspaceId, metric: "storage_bytes", hardLimit: 10 });
    const refused = await send(c.workspaceId, owner);
    expect(refused.status).toBe(429);
    expect(((await refused.json()) as { error: string }).error).toMatch(/Storage quota/);
  });

  it("does not let concurrent reservations pass a hard limit together", async () => {
    const c = newWorkspace("Race");
    usage.setLimit({ workspaceId: c.workspaceId, metric: "requests", hardLimit: 5 });
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, async () =>
        usage.reserveUsage({ workspaceId: c.workspaceId, metric: "requests", enforce: true }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
    expect(used(c.workspaceId, "requests")).toBe(5);
  });

  it("validates limits", () => {
    const c = newWorkspace("Validation");
    expect(() => usage.setLimit({ metric: "nope", hardLimit: 1 })).toThrow(/Unknown usage metric/);
    expect(() => usage.setLimit({ metric: "runs", softLimit: 5, hardLimit: 2 })).toThrow(/soft limit/);
    expect(() => usage.setLimit({ metric: "runs", hardLimit: -1 })).toThrow(/whole numbers/);
    expect(() => usage.setLimit({ metric: "runs", period: "week", hardLimit: 1 })).toThrow(/period/);
    expect(() =>
      usage.setLimit({ workspaceId: c.workspaceId, userId: other.id, metric: "runs", hardLimit: 1 }),
    ).toThrow(/not both/);
    expect(() => usage.setLimit({ workspaceId: "missing", metric: "runs", hardLimit: 1 })).toThrow(
      /not found/,
    );
  });
});

describe("reconciliation", () => {
  it("finds and repairs missing or wrong ledger entries, and repairing twice changes nothing", async () => {
    const c = newWorkspace("Reconcile");
    const { runId, summary } = await runs.startRun(c);
    getSqlite().prepare("DELETE FROM usage_events WHERE idem_key = ?").run(`run_requests:${runId}`);
    getSqlite().prepare("UPDATE usage_events SET amount = 1 WHERE idem_key = ?").run(`run_ms:${runId}`);
    const window = { from: 0, to: Date.now() + 86_400_000, workspaceId: c.workspaceId };
    const report = usage.reconcileRuns(window);
    expect(report).toMatchObject({
      runsChecked: 1,
      missing: 1,
      mismatched: summary.durationMs > 1 ? 1 : 0,
      repaired: 0,
    });
    expect(usage.reconcileRuns({ ...window, repair: true }).repaired).toBe(
      report.missing + report.mismatched,
    );
    expect(usage.reconcileRuns({ ...window, repair: true })).toMatchObject({
      missing: 0,
      mismatched: 0,
      repaired: 0,
    });
    expect(used(c.workspaceId, "requests")).toBe(summary.totalRequests);
  });
});

describe("routes", () => {
  it("shows an administrator every workspace and exports it", async () => {
    const res = await adminUsage.GET(req("GET", "/api/admin/usage", admin));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      workspaces: { workspaceName: string; lines: { metric: string }[] }[];
    };
    expect(body.workspaces.some((w) => w.workspaceName === "Accounting")).toBe(true);
    expect(body.workspaces[0].lines.map((l) => l.metric)).toEqual([
      "requests",
      "runs",
      "run_ms",
      "ai_tokens",
      "storage_bytes",
    ]);
    const csv = await adminUsage.GET(req("GET", "/api/admin/usage?export=csv", admin));
    expect(csv.headers.get("content-type")).toMatch(/text\/csv/);
    expect((await csv.text()).split("\r\n")[0]).toBe("from,to,workspaceId,workspace,metric,unit,used");
    expect(
      (await adminUsage.GET(req("GET", "/api/admin/usage?from=2026-02-01&to=2026-01-01", admin))).status,
    ).toBe(400);
    expect((await adminUsage.GET(req("GET", "/api/admin/usage", owner))).status).toBe(403);
  });

  it("filters by period", async () => {
    const future = Date.now() + 40 * 86_400_000;
    const res = await adminUsage.GET(
      req("GET", `/api/admin/usage?from=${future}&to=${future + 86_400_000}`, admin),
    );
    const body = (await res.json()) as { workspaces: { lines: { metric: string; used: number }[] }[] };
    for (const w of body.workspaces)
      for (const l of w.lines.filter((l) => l.metric !== "storage_bytes")) expect(l.used).toBe(0);
  });

  it("lets an owner read their workspace but not change limits", async () => {
    const c = newWorkspace("Owner view");
    const res = await workspaceUsage.GET(
      req("GET", `/api/workspaces/${c.workspaceId}/usage`, owner),
      ctx(c.workspaceId),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { lines: unknown[] }).lines).toHaveLength(5);
    expect(
      (
        await workspaceUsage.GET(
          req("GET", `/api/workspaces/${c.workspaceId}/usage`, other),
          ctx(c.workspaceId),
        )
      ).status,
    ).toBe(404);
    expect(
      (await limitsRoute.PUT(req("PUT", "/api/admin/usage/limits", owner, { metric: "runs", hardLimit: 1 })))
        .status,
    ).toBe(403);
  });

  it("creates, replaces and deletes limits as an administrator", async () => {
    const c = newWorkspace("Limit routes");
    const put = (body: object) => limitsRoute.PUT(req("PUT", "/api/admin/usage/limits", admin, body));
    const first = (await (
      await put({ workspaceId: c.workspaceId, metric: "ai_tokens", hardLimit: 100 })
    ).json()) as { id: string };
    const second = (await (
      await put({ workspaceId: c.workspaceId, metric: "ai_tokens", hardLimit: 200 })
    ).json()) as { id: string; hardLimit: number };
    expect(second).toMatchObject({ id: first.id, hardLimit: 200 });
    expect((await put({ metric: "ai_tokens", bogus: 1 })).status).toBe(400);
    const list = (await (await limitsRoute.GET(req("GET", "/api/admin/usage/limits", admin))).json()) as {
      id: string;
    }[];
    expect(list.filter((l) => l.id === first.id)).toHaveLength(1);
    expect(
      (await limitRoute.DELETE(req("DELETE", `/api/admin/usage/limits/${first.id}`, admin), ctx(first.id)))
        .status,
    ).toBe(200);
    expect(
      (await limitRoute.DELETE(req("DELETE", `/api/admin/usage/limits/${first.id}`, admin), ctx(first.id)))
        .status,
    ).toBe(404);
    expect(queryAudit({ action: "usage.limit" }).events.length).toBeGreaterThanOrEqual(3);
  });

  it("reconciles over the API", async () => {
    const res = await reconcileRoute.POST(
      req("POST", "/api/admin/usage/reconcile", admin, { repair: false }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ missing: expect.any(Number), repaired: 0 });
  });
});
