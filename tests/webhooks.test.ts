import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import {
  MAX_ATTEMPTS,
  RETRY_DELAYS_MS,
  buildEvent,
  checkTargetUrl,
  classifyStatus,
  nextDelay,
  signPayload,
  verifySignature,
} from "@/core/webhooks";
import type { UserRow } from "@/server/db/schema";
import type { Caller } from "@/server/caller";
import { startTestServer, type TestServer } from "./helpers/server";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-webhooks-"));
process.env.DATABASE_PATH = path.join(dir, "db.sqlite");
process.env.PROXY_DENY_HOSTS = "blocked.example";
const users = await import("@/server/users");
const repo = await import("@/server/repo");
const hooks = await import("@/server/webhooks");
const runs = await import("@/server/runs");
const { withCaller } = await import("@/server/access-context");
const { setMember } = await import("@/server/authorize");
const { getSqlite } = await import("@/server/db");
const { queryAudit } = await import("@/server/audit");
const listRoute = await import("@/app/api/webhooks/route");
const oneRoute = await import("@/app/api/webhooks/[id]/route");
const rotateRoute = await import("@/app/api/webhooks/[id]/rotate/route");
const testRoute = await import("@/app/api/webhooks/[id]/test/route");
const deliveriesRoute = await import("@/app/api/webhooks/[id]/deliveries/route");
const replayRoute = await import("@/app/api/webhooks/[id]/replay/route");

// ------------------------------------------------------------------ pure rules

describe("webhook signatures", () => {
  const body = JSON.stringify({ hello: "world" });
  const at = Date.UTC(2026, 0, 1);

  it("verifies what it signs and rejects tampering, wrong secrets and stale timestamps", () => {
    const header = signPayload("whsec_a", body, at);
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(verifySignature("whsec_a", body, header, at + 1000)).toBe(true);
    expect(verifySignature("whsec_b", body, header, at)).toBe(false);
    expect(verifySignature("whsec_a", body + " ", header, at)).toBe(false);
    expect(verifySignature("whsec_a", body, header, at + 301_000)).toBe(false);
    expect(verifySignature("whsec_a", body, "garbage", at)).toBe(false);
    expect(verifySignature("whsec_a", body, `t=${at / 1000},v1=zz`, at)).toBe(false);
  });

  it("builds a stable event envelope", () => {
    expect(buildEvent("e1", "run.passed", "w1", { n: 1 }, at)).toEqual({
      id: "e1",
      type: "run.passed",
      createdAt: "2026-01-01T00:00:00.000Z",
      workspaceId: "w1",
      data: { n: 1 },
    });
  });
});

describe("retry rules", () => {
  it("classifies HTTP statuses", () => {
    expect(classifyStatus(204, undefined, 0)).toEqual({ kind: "delivered" });
    for (const status of [408, 425, 429, 500, 503])
      expect(classifyStatus(status, undefined, 0).kind).toBe("retry");
    for (const status of [301, 302, 400, 401, 404, 410, 422])
      expect(classifyStatus(status, undefined, 0).kind).toBe("fatal");
  });

  it("backs off, honours a longer Retry-After and stops at the attempt limit", () => {
    expect([1, 2, 3, 4, 5].map((n) => nextDelay(n))).toEqual([...RETRY_DELAYS_MS]);
    expect(nextDelay(MAX_ATTEMPTS)).toBeNull();
    expect(nextDelay(1, 120_000)).toBe(120_000);
    expect(nextDelay(1, 1000)).toBe(10_000);
    expect(classifyStatus(429, "30", 0)).toEqual({ kind: "retry", retryAfterMs: 30_000 });
    expect(classifyStatus(503, "999999", 0)).toEqual({ kind: "retry", retryAfterMs: 3_600_000 });
    expect(classifyStatus(503, "nonsense", 0)).toEqual({ kind: "retry", retryAfterMs: undefined });
  });

  it("accepts only plain http(s) targets without credentials", () => {
    expect(checkTargetUrl("https://example.com/hook")).toBeNull();
    expect(checkTargetUrl("http://localhost:3000/x")).toBeNull();
    for (const bad of ["ftp://example.com", "https://u:p@example.com", "not a url", "https://example.com/#x"])
      expect(checkTargetUrl(bad)).not.toBeNull();
  });
});

// ------------------------------------------------------------------ service

interface Received {
  headers: http.IncomingHttpHeaders;
  body: string;
  url: string;
}
let receiver: http.Server;
let base: string;
const received: Received[] = [];
/** Scripted responses, consumed in order; the default is 200. */
let script: { status: number; headers?: Record<string, string> }[] = [];

let local: TestServer;
let owner: UserRow, editor: UserRow, outsider: UserRow;
const keys: Record<string, string> = {};
const caller = (user: UserRow): Caller => ({ kind: "user", user, via: "token" });
const req = (method: string, url: string, user: UserRow, body?: unknown) =>
  new Request("http://localhost" + url, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${keys[user.id]}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
let workspaceId: string;

beforeAll(async () => {
  hooks.setWebhookWorkerManual(true);
  local = await startTestServer();
  receiver = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received.push({
        headers: request.headers,
        body: Buffer.concat(chunks).toString("utf8"),
        url: request.url!,
      });
      const next = script.shift() ?? { status: 200 };
      response.writeHead(next.status, next.headers);
      response.end("ok");
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
  owner = await users.createUser({ username: "owner", password: "password123" });
  editor = await users.createUser({ username: "editor", password: "password123" });
  outsider = await users.createUser({ username: "outsider", password: "password123" });
  for (const user of [owner, editor, outsider]) keys[user.id] = users.createToken(user.id, "t").token;
  workspaceId = withCaller(caller(owner), () => repo.createWorkspace("Hooks").id);
  withCaller(caller(owner), () => setMember(workspaceId, editor.username, "editor"));
});

afterAll(async () => {
  await local?.close();
  await new Promise((resolve) => receiver?.close(resolve));
});

beforeEach(() => {
  received.length = 0;
  script = [];
  getSqlite().exec("DELETE FROM webhook_deliveries; DELETE FROM webhooks;");
});

const make = (overrides: Record<string, unknown> = {}) =>
  hooks.createWebhook(workspaceId, {
    name: "Receiver",
    url: base + "/hook",
    events: ["run.passed", "run.failed"],
    ...overrides,
  } as Parameters<typeof hooks.createWebhook>[1]);
const deliveries = (id: string) => hooks.listDeliveries(id, { limit: 200 });
const farFuture = () => Date.now() + 10 * 86_400_000;

describe("webhook configuration", () => {
  it("shows the secret once and never lists it", async () => {
    const response = await listRoute.POST(
      req("POST", "/api/webhooks", owner, {
        workspaceId,
        name: "CI",
        url: base + "/ci",
        events: ["run.failed", "run.failed"],
      }),
    );
    expect(response.status).toBe(201);
    const created = await response.json();
    expect(created.secret).toMatch(/^whsec_[\w-]{43}$/);
    expect(created.events).toEqual(["run.failed"]);

    const listed = await (
      await listRoute.GET(req("GET", `/api/webhooks?workspaceId=${workspaceId}`, owner))
    ).json();
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(created.secret);
    const one = await (
      await oneRoute.GET(req("GET", `/api/webhooks/${created.id}`, owner), ctx(created.id))
    ).json();
    expect(one).not.toHaveProperty("secret");
  });

  it("is limited to workspace owners", async () => {
    const hook = make();
    const body = { workspaceId, name: "x", url: base, events: ["run.passed"] };
    expect((await listRoute.POST(req("POST", "/api/webhooks", editor, body))).status).toBe(403);
    expect((await listRoute.POST(req("POST", "/api/webhooks", outsider, body))).status).toBe(404);
    expect((await listRoute.GET(req("GET", `/api/webhooks?workspaceId=${workspaceId}`, editor))).status).toBe(
      403,
    );
    expect((await oneRoute.GET(req("GET", `/api/webhooks/${hook.id}`, editor), ctx(hook.id))).status).toBe(
      403,
    );
    expect(
      (await oneRoute.DELETE(req("DELETE", `/api/webhooks/${hook.id}`, outsider), ctx(hook.id))).status,
    ).toBe(404);
    expect(
      (await listRoute.POST(new Request("http://localhost/api/webhooks", { method: "POST", body: "{}" })))
        .status,
    ).toBe(401);
  });

  it("rejects bad targets, unknown events and targets the outbound policy blocks", async () => {
    const post = (extra: Record<string, unknown>) =>
      listRoute.POST(
        req("POST", "/api/webhooks", owner, {
          workspaceId,
          name: "x",
          url: base,
          events: ["run.passed"],
          ...extra,
        }),
      );
    expect((await post({ url: "ftp://example.com" })).status).toBe(400);
    expect((await post({ url: "https://user:pw@example.com/" })).status).toBe(400);
    expect((await post({ events: ["run.exploded"] })).status).toBe(400);
    expect((await post({ events: [] })).status).toBe(400);
    const blocked = await post({ url: "https://blocked.example/hook" });
    expect(blocked.status).toBe(400);
    expect((await blocked.json()).error).toContain("outbound policy");
  });

  it("updates, rotates the secret and deletes with its history", async () => {
    const hook = make();
    const patched = await (
      await oneRoute.PATCH(
        req("PATCH", `/api/webhooks/${hook.id}`, owner, { name: "Renamed", enabled: false }),
        ctx(hook.id),
      )
    ).json();
    expect(patched).toMatchObject({ name: "Renamed", enabled: false, url: base + "/hook" });

    const rotated = await (
      await rotateRoute.POST(req("POST", `/api/webhooks/${hook.id}/rotate`, owner), ctx(hook.id))
    ).json();
    expect(rotated.secret).not.toBe(hook.secret);

    hooks.updateWebhook(hook.id, { enabled: true });
    hooks.emitEvent(workspaceId, "run.passed", {});
    expect(deliveries(hook.id)).toHaveLength(1);
    await oneRoute.DELETE(req("DELETE", `/api/webhooks/${hook.id}`, owner), ctx(hook.id));
    expect(getSqlite().prepare("SELECT COUNT(*) AS n FROM webhook_deliveries").get()).toEqual({ n: 0 });
  });

  it("keeps secrets out of the audit log", async () => {
    const response = await listRoute.POST(
      req("POST", "/api/webhooks", owner, {
        workspaceId,
        name: "Audited",
        url: base + "?token=abc",
        events: ["run.passed"],
      }),
    );
    const created = await response.json();
    const events = queryAudit({ workspaceId, limit: 50 } as never);
    const text = JSON.stringify(events);
    expect(text).toContain("webhook");
    expect(text).not.toContain(created.secret);
    expect(text).not.toContain("token=abc");
  });
});

describe("webhook delivery", () => {
  it("signs and sends subscribed events, once, with stable identifiers", async () => {
    const hook = make();
    make({ name: "Other", events: ["run.cancelled"], url: base + "/other" });
    expect(hooks.emitEvent(workspaceId, "run.passed", { runId: "r1" })).toBe(1);
    expect(await hooks.processDue()).toBe(1);

    expect(received).toHaveLength(1);
    const [sent] = received;
    expect(sent.url).toBe("/hook");
    expect(sent.headers["content-type"]).toBe("application/json");
    expect(sent.headers["postbox-event"]).toBe("run.passed");
    expect(sent.headers["postbox-delivery-attempt"]).toBe("1");
    expect(
      verifySignature(hook.secret, sent.body, String(sent.headers["postbox-signature"]), Date.now()),
    ).toBe(true);
    const event = JSON.parse(sent.body);
    expect(event).toMatchObject({ type: "run.passed", workspaceId, data: { runId: "r1" } });
    expect(sent.headers["postbox-event-id"]).toBe(event.id);

    const [delivery] = deliveries(hook.id);
    expect(delivery).toMatchObject({ status: "delivered", attempts: 1, lastStatus: 200, eventId: event.id });
    expect(sent.headers["postbox-delivery"]).toBe(delivery.id);
    expect(await hooks.processDue()).toBe(0);
    expect(received).toHaveLength(1);
    expect(hooks.getDelivery(hook.id, delivery.id).attemptLog).toHaveLength(1);
  });

  it("sends nothing for disabled webhooks or unsubscribed events", async () => {
    make({ enabled: false });
    expect(hooks.emitEvent(workspaceId, "run.passed", {})).toBe(0);
    expect(hooks.emitEvent(workspaceId, "run.error", {})).toBe(0);
    expect(await hooks.processDue()).toBe(0);
    expect(received).toHaveLength(0);
  });

  it("does not send an event queued before the webhook was disabled", async () => {
    const hook = make();
    hooks.emitEvent(workspaceId, "run.passed", {});
    hooks.updateWebhook(hook.id, { enabled: false });
    await hooks.processDue();
    expect(received).toHaveLength(0);
    expect(deliveries(hook.id)[0]).toMatchObject({ status: "failed" });
    expect(deliveries(hook.id)[0].lastError).toContain("disabled");
  });

  it("retries a failing receiver on a schedule, reusing the delivery and event ids", async () => {
    const hook = make();
    script = [{ status: 500 }, { status: 502 }, { status: 200 }];
    hooks.emitEvent(workspaceId, "run.failed", {});
    await hooks.processDue();
    let [delivery] = deliveries(hook.id);
    expect(delivery).toMatchObject({ status: "pending", attempts: 1, lastStatus: 500 });
    expect(delivery.nextAttemptAt! - Date.now()).toBeGreaterThan(RETRY_DELAYS_MS[0] - 1000);

    expect(await hooks.processDue()).toBe(0);
    expect(await hooks.processDue(Date.now() + RETRY_DELAYS_MS[0] + 1000)).toBe(1);
    expect(await hooks.processDue(Date.now() + RETRY_DELAYS_MS[1] + RETRY_DELAYS_MS[0] + 2000)).toBe(1);
    [delivery] = deliveries(hook.id);
    expect(delivery).toMatchObject({ status: "delivered", attempts: 3 });

    expect(received).toHaveLength(3);
    expect(new Set(received.map((r) => r.headers["postbox-delivery"]))).toEqual(new Set([delivery.id]));
    expect(new Set(received.map((r) => r.headers["postbox-event-id"]))).toEqual(new Set([delivery.eventId]));
    expect(received.map((r) => r.headers["postbox-delivery-attempt"])).toEqual(["1", "2", "3"]);
    expect(received[0].body).toBe(received[2].body);
  });

  it("gives up after the attempt limit", async () => {
    const hook = make();
    script = Array.from({ length: 10 }, () => ({ status: 503 }));
    hooks.emitEvent(workspaceId, "run.failed", {});
    for (let attempt = 0; attempt < MAX_ATTEMPTS + 2; attempt++) await hooks.processDue(farFuture());
    const [delivery] = deliveries(hook.id);
    expect(received).toHaveLength(MAX_ATTEMPTS);
    expect(delivery).toMatchObject({ status: "failed", attempts: MAX_ATTEMPTS });
    expect(delivery.lastError).toContain("Gave up");
  });

  it("does not retry permanent failures or follow redirects", async () => {
    const hook = make();
    script = [{ status: 400 }];
    hooks.emitEvent(workspaceId, "run.passed", {});
    await hooks.processDue(farFuture());
    await hooks.processDue(farFuture());
    expect(received).toHaveLength(1);
    expect(deliveries(hook.id)[0]).toMatchObject({ status: "failed", attempts: 1, lastStatus: 400 });

    script = [{ status: 302, headers: { Location: base + "/elsewhere" } }];
    hooks.emitEvent(workspaceId, "run.passed", {});
    await hooks.processDue(farFuture());
    await hooks.processDue(farFuture());
    expect(received.map((r) => r.url)).toEqual(["/hook", "/hook"]);
    expect(deliveries(hook.id)[0].lastError).toContain("Redirects are not followed");
  });

  it("waits at least as long as the receiver's Retry-After", async () => {
    const hook = make();
    script = [{ status: 429, headers: { "Retry-After": "600" } }];
    hooks.emitEvent(workspaceId, "run.passed", {});
    await hooks.processDue();
    expect(deliveries(hook.id)[0].nextAttemptAt! - Date.now()).toBeGreaterThan(590_000);
  });

  it("retries when the receiver cannot be reached", async () => {
    const hook = make({ url: "http://127.0.0.1:9/never" });
    hooks.emitEvent(workspaceId, "run.passed", {});
    await hooks.processDue();
    expect(deliveries(hook.id)[0]).toMatchObject({ status: "pending", attempts: 1, lastStatus: null });
    expect(deliveries(hook.id)[0].lastError).toBeTruthy();
  });

  it("refuses at send time a target the outbound policy now blocks", async () => {
    const hook = make();
    getSqlite()
      .prepare("UPDATE webhooks SET url = ? WHERE id = ?")
      .run("https://blocked.example/hook", hook.id);
    hooks.emitEvent(workspaceId, "run.passed", {});
    await hooks.processDue();
    expect(received).toHaveLength(0);
    expect(deliveries(hook.id)[0]).toMatchObject({ status: "failed", attempts: 1 });
    expect(deliveries(hook.id)[0].lastError).toContain("outbound policy");
  });

  it("never sends one delivery twice, even when workers overlap", async () => {
    const hook = make();
    hooks.emitEvent(workspaceId, "run.passed", {});
    const results = await Promise.all([hooks.processDue(), hooks.processDue(), hooks.processDue()]);
    expect(results.reduce((a, b) => a + b, 0)).toBe(1);
    expect(received).toHaveLength(1);
    expect(deliveries(hook.id)[0].attempts).toBe(1);
  });

  it("recovers a delivery whose worker died, but not one that is still claimed", async () => {
    const hook = make();
    hooks.emitEvent(workspaceId, "run.passed", {});
    const [delivery] = deliveries(hook.id);
    getSqlite()
      .prepare("UPDATE webhook_deliveries SET locked_until = ? WHERE id = ?")
      .run(Date.now() + 60_000, delivery.id);
    expect(await hooks.processDue()).toBe(0);
    getSqlite()
      .prepare("UPDATE webhook_deliveries SET locked_until = ? WHERE id = ?")
      .run(Date.now() - 1, delivery.id);
    expect(await hooks.processDue()).toBe(1);
    expect(deliveries(hook.id)[0].status).toBe("delivered");
  });

  it("signs queued events with the secret current at send time", async () => {
    const hook = make();
    hooks.emitEvent(workspaceId, "run.passed", {});
    const rotated = hooks.rotateWebhookSecret(hook.id);
    await hooks.processDue();
    const header = String(received[0].headers["postbox-signature"]);
    expect(verifySignature(rotated.secret, received[0].body, header, Date.now())).toBe(true);
    expect(verifySignature(hook.secret, received[0].body, header, Date.now())).toBe(false);
  });

  it("stops queueing when too many deliveries are waiting", () => {
    const hook = make();
    for (let i = 0; i < hooks.MAX_PENDING_PER_WEBHOOK + 2; i++)
      hooks.emitEvent(workspaceId, "run.passed", { i });
    expect(deliveries(hook.id)).toHaveLength(200);
    const rows = getSqlite()
      .prepare("SELECT status, COUNT(*) AS n FROM webhook_deliveries GROUP BY status")
      .all();
    expect(rows).toEqual(
      expect.arrayContaining([
        { status: "failed", n: 2 },
        { status: "pending", n: hooks.MAX_PENDING_PER_WEBHOOK },
      ]),
    );
  });
});

describe("test events and replay", () => {
  it("sends a test event to one webhook regardless of its subscriptions", async () => {
    const hook = make({ events: ["run.cancelled"] });
    const other = make({ name: "Other", url: base + "/other" });
    const response = await testRoute.POST(req("POST", `/api/webhooks/${hook.id}/test`, owner), ctx(hook.id));
    expect(response.status).toBe(202);
    await hooks.processDue();
    expect(received).toHaveLength(1);
    expect(received[0].url).toBe("/hook");
    expect(received[0].headers["postbox-event"]).toBe("webhook.test");
    expect(deliveries(other.id)).toHaveLength(0);
  });

  it("replays a finished delivery as a new delivery of the same event", async () => {
    const hook = make();
    hooks.emitEvent(workspaceId, "run.passed", { runId: "r9" });
    await hooks.processDue();
    const [original] = deliveries(hook.id);

    const response = await replayRoute.POST(
      req("POST", `/api/webhooks/${hook.id}/replay`, owner, { deliveryId: original.id }),
      ctx(hook.id),
    );
    expect(response.status).toBe(202);
    const replay = await response.json();
    expect(replay).toMatchObject({
      eventId: original.eventId,
      replayOf: original.id,
      status: "pending",
      attempts: 0,
    });
    expect(replay.id).not.toBe(original.id);
    await hooks.processDue();

    // The receiver sees the same event twice, under different delivery ids: it must deduplicate on the event id.
    expect(received).toHaveLength(2);
    expect(received[0].headers["postbox-event-id"]).toBe(received[1].headers["postbox-event-id"]);
    expect(received[0].headers["postbox-delivery"]).not.toBe(received[1].headers["postbox-delivery"]);
    expect(received[0].body).toBe(received[1].body);
  });

  it("will not replay a delivery that is still waiting, or one from another webhook", async () => {
    const hook = make();
    const other = make({ name: "Other" });
    hooks.emitEvent(workspaceId, "run.passed", {});
    const [pending] = deliveries(hook.id);
    const waiting = await replayRoute.POST(
      req("POST", `/api/webhooks/${hook.id}/replay`, owner, { deliveryId: pending.id }),
      ctx(hook.id),
    );
    expect(waiting.status).toBe(409);
    await hooks.processDue();
    const foreign = await replayRoute.POST(
      req("POST", `/api/webhooks/${other.id}/replay`, owner, { deliveryId: pending.id }),
      ctx(other.id),
    );
    expect(foreign.status).toBe(404);
  });

  it("lists deliveries with filters and one delivery's attempts", async () => {
    const hook = make();
    script = [{ status: 500 }];
    hooks.emitEvent(workspaceId, "run.passed", {});
    await hooks.processDue();
    const pending = await (
      await deliveriesRoute.GET(
        req("GET", `/api/webhooks/${hook.id}/deliveries?status=pending`, owner),
        ctx(hook.id),
      )
    ).json();
    expect(pending).toHaveLength(1);
    const done = await (
      await deliveriesRoute.GET(
        req("GET", `/api/webhooks/${hook.id}/deliveries?status=delivered`, owner),
        ctx(hook.id),
      )
    ).json();
    expect(done).toHaveLength(0);
    const detail = await (
      await deliveriesRoute.GET(
        req("GET", `/api/webhooks/${hook.id}/deliveries?delivery=${pending[0].id}`, owner),
        ctx(hook.id),
      )
    ).json();
    expect(detail.attemptLog).toHaveLength(1);
    expect(detail.attemptLog[0]).toMatchObject({ status: 500 });
    expect(detail.payload).toMatchObject({ type: "run.passed" });
    expect(JSON.stringify(detail)).not.toContain(hook.secret);
  });
});

describe("retention", () => {
  it("removes old finished deliveries but keeps waiting ones", async () => {
    const hook = make();
    hooks.emitEvent(workspaceId, "run.passed", {});
    await hooks.processDue();
    hooks.emitEvent(workspaceId, "run.passed", {});
    getSqlite()
      .prepare("UPDATE webhook_deliveries SET created_at = ?")
      .run(Date.now() - 40 * 86_400_000);
    expect(hooks.pruneWebhooks(30)).toBe(1);
    expect(deliveries(hook.id).map((d) => d.status)).toEqual(["pending"]);
    expect(hooks.pruneWebhooks(0)).toBe(0);
  });
});

describe("run events", () => {
  it("queues run.passed and run.failed with totals only", async () => {
    const hook = make();
    const folder = repo.createFolder(workspaceId, null, { name: "Suite" });
    const pass = repo.createRequest(workspaceId, folder.id, { url: local.url + "/echo" });
    const first = await withCaller(caller(owner), () =>
      runs.startRun({ workspaceId, folderId: folder.id, environmentId: null }),
    );
    expect(first.summary.status).toBe("passed");

    repo.updateRequest(pass.id, { testScript: 'pm.test("fails", () => { throw new Error("nope"); });' });
    const second = await withCaller(caller(owner), () =>
      runs.startRun({ workspaceId, folderId: folder.id, environmentId: null }),
    );
    expect(second.summary.status).toBe("failed");

    await hooks.processDue();
    const types = received.map((r) => JSON.parse(r.body).type).sort();
    expect(types).toEqual(["run.failed", "run.passed"]);
    const failed = JSON.parse(received.find((r) => JSON.parse(r.body).type === "run.failed")!.body);
    expect(failed.data).toMatchObject({
      runId: second.runId,
      folderId: folder.id,
      name: "Suite",
      status: "failed",
      failedTests: 1,
    });
    expect(Object.keys(failed.data)).not.toContain("results");
    expect(deliveries(hook.id)).toHaveLength(2);
  });

  // Keep last: it removes the outbox tables.
  it("never lets a webhook problem fail the run", async () => {
    make();
    getSqlite().exec("DROP TABLE webhook_attempts; DROP TABLE webhook_deliveries;");
    const folder = repo.createFolder(workspaceId, null, { name: "Safe" });
    repo.createRequest(workspaceId, folder.id, { url: local.url + "/echo" });
    const result = await withCaller(caller(owner), () =>
      runs.startRun({ workspaceId, folderId: folder.id, environmentId: null }),
    );
    expect(result.summary.status).toBe("passed");
  });
});
