import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import {
  AdapterError,
  checkCustomHeaders,
  renderAdapter,
  summarize,
  WEBHOOK_FORMATS,
} from "@/core/webhook-adapters";
import { buildEvent, verifySignature } from "@/core/webhooks";
import type { Caller } from "@/server/caller";
import type { UserRow } from "@/server/db/schema";

const at = Date.UTC(2026, 0, 1);
const failed = buildEvent(
  "e1",
  "run.failed",
  "w1",
  {
    runId: "r1",
    folderId: "f1",
    name: "Shop <API>",
    totalRequests: 10,
    failedRequests: 3,
    failedTests: 2,
    durationMs: 4200,
  },
  at,
);
const passed = buildEvent(
  "e2",
  "run.passed",
  "w1",
  { folderId: "f1", name: "Shop", totalRequests: 10, passedTests: 7, durationMs: 1000 },
  at,
);
const load = buildEvent(
  "e3",
  "load.failed",
  "w1",
  {
    folderId: "f2",
    name: "Checkout",
    requests: 500,
    rps: 41.2,
    p95Ms: 812,
    errorRate: 0.031,
    peakVus: 20,
    thresholdsFailed: 2,
  },
  at,
);
const raw = (e: unknown) => JSON.stringify(e);

describe("adapter formats", () => {
  it("summarises events for people", () => {
    expect(summarize(failed)).toMatchObject({
      title: "Run failed: Shop <API>",
      severity: "bad",
      incident: "trigger",
      key: "run:f1",
    });
    expect(summarize(passed)).toMatchObject({ severity: "good", incident: "resolve", key: "run:f1" });
    expect(summarize(load).detail).toMatch(
      /2 threshold\(s\) failed.*500 requests at 41.2\/s, p95 812 ms, errors 3.1%/,
    );
    expect(summarize(buildEvent("x", "webhook.test", "w", { message: "hi" }, at))).toMatchObject({
      title: "Test event from Postbox",
      incident: "none",
    });
  });

  it("keeps the Postbox format byte for byte", () => {
    const r = renderAdapter("postbox", failed, raw(failed));
    expect(r.body).toBe(raw(failed));
    expect(r.contentType).toBe("application/json");
  });

  it("builds Slack messages and escapes markup", () => {
    const body = JSON.parse(renderAdapter("slack", failed, raw(failed)).body);
    expect(body.text).toContain("Run failed: Shop <API>");
    expect(body.blocks[0].text.text).toContain("Shop &lt;API&gt;");
    expect(body.blocks[0].text.text).not.toContain("<API>");
  });

  it("builds Discord messages that cannot ping anyone", () => {
    const body = JSON.parse(renderAdapter("discord", failed, raw(failed)).body);
    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(body.embeds[0]).toMatchObject({
      title: "Run failed: Shop <API>",
      color: 0xe01e5a,
      timestamp: failed.createdAt,
    });
    const long = buildEvent("l", "run.failed", "w", { name: "x".repeat(5000) }, at);
    const big = JSON.parse(renderAdapter("discord", long, raw(long)).body);
    expect(big.content.length).toBeLessThanOrEqual(2000);
    expect(big.embeds[0].title.length).toBeLessThanOrEqual(256);
  });

  it("builds Teams message cards", () => {
    const body = JSON.parse(renderAdapter("teams", passed, raw(passed)).body);
    expect(body).toMatchObject({ "@type": "MessageCard", themeColor: "2EB67D", title: "Run passed: Shop" });
  });

  it("opens and resolves PagerDuty incidents with a stable key, and needs a routing key", () => {
    expect(() => renderAdapter("pagerduty", failed, raw(failed))).toThrow(AdapterError);
    const open = JSON.parse(renderAdapter("pagerduty", failed, raw(failed), { routingKey: "RK" }).body);
    expect(open).toMatchObject({
      routing_key: "RK",
      event_action: "trigger",
      dedup_key: "postbox:run:f1",
      payload: { severity: "error", source: "postbox" },
    });
    const close = JSON.parse(renderAdapter("pagerduty", passed, raw(passed), { routingKey: "RK" }).body);
    expect(close).toMatchObject({ event_action: "resolve", dedup_key: "postbox:run:f1" });
    const cancelled = buildEvent("c", "run.cancelled", "w", { name: "n", folderId: "f1" }, at);
    expect(
      JSON.parse(renderAdapter("pagerduty", cancelled, raw(cancelled), { routingKey: "RK" }).body),
    ).toMatchObject({ event_action: "trigger", payload: { severity: "info" }, dedup_key: "postbox:c" });
    expect(WEBHOOK_FORMATS).toContain("pagerduty");
  });

  it("validates custom headers", () => {
    expect(
      checkCustomHeaders([
        { name: "X-Team", value: "a" },
        { name: "Authorization", value: "Bearer {{vault:t}}" },
      ]),
    ).toBeNull();
    for (const bad of [
      [{ name: "Content-Type", value: "x" }],
      [{ name: "Host", value: "x" }],
      [{ name: "Postbox-Signature", value: "x" }],
      [{ name: "bad name", value: "x" }],
      [{ name: "X-A", value: "a\r\nX-B: b" }],
      [
        { name: "X-A", value: "1" },
        { name: "x-a", value: "2" },
      ],
    ])
      expect(checkCustomHeaders(bad)).toEqual(expect.any(String));
    expect(
      checkCustomHeaders(Array.from({ length: 11 }, (_, i) => ({ name: `X-${i}`, value: "v" }))),
    ).toMatch(/At most 10/);
  });
});

// ------------------------------------------------------------------ with the vault

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-webhook-adapters-"));
process.env.DATABASE_PATH = path.join(dir, "db.sqlite");
process.env.POSTBOX_VAULT_KEY_FILE = path.join(dir, "vault.keys.json");
delete process.env.POSTBOX_VAULT_KEY;
const users = await import("@/server/users");
const repo = await import("@/server/repo");
const hooks = await import("@/server/webhooks");
const vault = await import("@/server/vault");
const { withCaller } = await import("@/server/access-context");
const { getSqlite } = await import("@/server/db");
const { queryAudit } = await import("@/server/audit");
const listRoute = await import("@/app/api/webhooks/route");
const oneRoute = await import("@/app/api/webhooks/[id]/route");
const rotateRoute = await import("@/app/api/webhooks/[id]/rotate/route");

interface Received {
  headers: http.IncomingHttpHeaders;
  body: string;
  url: string;
}
let receiver: http.Server;
let base = "";
const received: Received[] = [];
let respond = 200;
let owner: UserRow;
let workspaceId = "";
const caller = (u: UserRow): Caller => ({ kind: "user", user: u, via: "token" });
const keys: Record<string, string> = {};
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const request = (method: string, url: string, body?: unknown) =>
  new Request("http://localhost" + url, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${keys[owner.id]}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const asOwner = <T>(fn: () => T) => withCaller(caller(owner), fn);
const SLACK_PATH = "/services/T000/B000/SLACKTOKEN123456";

beforeAll(async () => {
  hooks.setWebhookWorkerManual(true);
  receiver = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      received.push({ headers: req.headers, body: Buffer.concat(chunks).toString("utf8"), url: req.url! });
      res.writeHead(respond);
      res.end("ok");
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
  owner = await users.createUser({ username: "owner", password: "password123" });
  keys[owner.id] = users.createToken(owner.id, "t").token;
  workspaceId = asOwner(() => repo.createWorkspace("Adapters").id);
  asOwner(() => {
    vault.createSecret(workspaceId, { name: "slack-url", value: base + SLACK_PATH });
    vault.createSecret(workspaceId, { name: "pd-key", value: "PD-ROUTING-KEY-0123456789" });
    vault.createSecret(workspaceId, { name: "signing", value: "vault-signing-secret-value" });
    vault.createSecret(workspaceId, { name: "bearer", value: "tok_header_secret_998877" });
    vault.createSecret(workspaceId, {
      name: "scoped",
      value: "scoped-secret-value-1",
      collectionIds: [repo.createFolder(workspaceId, null, { name: "C" }).id],
    });
    vault.createSecret(workspaceId, { name: "mine", value: "personal-secret-value-1", personal: true });
  });
});
afterAll(async () => {
  await new Promise((resolve) => receiver.close(resolve));
  getSqlite().close();
  fs.rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  received.length = 0;
  respond = 200;
  getSqlite().exec("DELETE FROM webhook_deliveries; DELETE FROM webhooks;");
});

const make = (extra: Record<string, unknown> = {}) =>
  asOwner(() =>
    hooks.createWebhook(workspaceId, {
      name: "Hook",
      url: base + "/hook",
      events: ["run.passed", "run.failed"],
      ...extra,
    } as Parameters<typeof hooks.createWebhook>[1]),
  );
const send = async (hook: { id: string }) => {
  asOwner(() => hooks.emitEvent(workspaceId, "run.failed", failed.data));
  await hooks.processDue(Date.now() + 1000);
  return hooks.listDeliveries(hook.id, { limit: 50 });
};

describe("vault references", () => {
  it("keeps a Slack URL in the vault and never shows it", async () => {
    const plain = await listRoute.POST(
      request("POST", "/api/webhooks", {
        workspaceId,
        name: "S",
        url: base + SLACK_PATH,
        events: ["run.failed"],
        format: "slack",
      }),
    );
    expect(plain.status).toBe(400);
    expect((await plain.json()).error).toMatch(/Store it in the secrets vault/);
    const res = await listRoute.POST(
      request("POST", "/api/webhooks", {
        workspaceId,
        name: "S",
        url: "{{vault:slack-url}}",
        events: ["run.failed"],
        format: "slack",
      }),
    );
    expect(res.status).toBe(201);
    const created = await res.json();
    const hook = { id: created.id as string };
    const out = await send(hook);
    expect(out[0].status).toBe("delivered");
    expect(received).toHaveLength(1);
    expect(received[0].url).toBe(SLACK_PATH);
    expect(JSON.parse(received[0].body).text).toContain("Run failed: Shop <API>");
    // What the API, the audit log and the delivery records hold is the reference, never the URL.
    const everywhere = JSON.stringify([
      await (await oneRoute.GET(request("GET", `/api/webhooks/${hook.id}`), ctx(hook.id))).json(),
      await (await listRoute.GET(request("GET", `/api/webhooks?workspaceId=${workspaceId}`))).json(),
      hooks.getDelivery(hook.id, out[0].id),
      queryAudit({ workspaceId, limit: 500 } as never),
      getSqlite().prepare("SELECT * FROM webhook_deliveries").all(),
      getSqlite().prepare("SELECT * FROM webhook_attempts").all(),
    ]);
    expect(everywhere).not.toContain("SLACKTOKEN123456");
    expect(everywhere).toContain("{{vault:slack-url}}");
  });

  it("signs with a vault secret and drops the stored key", async () => {
    const hook = make({ signingKeyRef: "signing" });
    expect(hook.secret).toBeNull();
    expect(hook.signingKeyRef).toBe("signing");
    expect(getSqlite().prepare("SELECT secret FROM webhooks WHERE id = ?").get(hook.id)).toEqual({
      secret: "",
    });
    await send(hook);
    expect(
      verifySignature(
        "vault-signing-secret-value",
        received[0].body,
        String(received[0].headers["postbox-signature"]),
        Date.now(),
      ),
    ).toBe(true);
    // Rotating is refused: the key is the vault secret.
    const rotate = await rotateRoute.POST(request("POST", `/api/webhooks/${hook.id}/rotate`), ctx(hook.id));
    expect(rotate.status).toBe(409);
    // A replaced vault value takes effect on the next delivery.
    const id = asOwner(() => vault.listSecrets(workspaceId)).find((s) => s.name === "signing")!.id;
    asOwner(() => vault.updateSecret(id, { value: "second-signing-value-xyz" }));
    received.length = 0;
    await send(hook);
    expect(
      verifySignature(
        "second-signing-value-xyz",
        received[0].body,
        String(received[0].headers["postbox-signature"]),
        Date.now(),
      ),
    ).toBe(true);
    asOwner(() => vault.updateSecret(id, { value: "vault-signing-secret-value" }));
  });

  it("only accepts secrets that webhooks can actually use", async () => {
    for (const name of ["missing", "scoped", "mine"]) {
      const res = await listRoute.POST(
        request("POST", "/api/webhooks", {
          workspaceId,
          name: "x",
          url: base,
          events: ["run.passed"],
          signingKeyRef: name,
        }),
      );
      expect(res.status, name).toBe(400);
      expect((await res.json()).error).toMatch(/not available to webhooks/);
    }
    const badHeader = await listRoute.POST(
      request("POST", "/api/webhooks", {
        workspaceId,
        name: "x",
        url: base,
        events: ["run.passed"],
        headers: [{ name: "X-A", value: "{{vault:scoped}}" }],
      }),
    );
    expect(badHeader.status).toBe(400);
  });

  it("fails clearly, without retrying, when a referenced secret later goes away", async () => {
    const hook = make({ signingKeyRef: "signing" });
    const id = asOwner(() => vault.listSecrets(workspaceId)).find((s) => s.name === "signing")!.id;
    asOwner(() => vault.updateSecret(id, { enabled: false }));
    const out = await send(hook);
    expect(out[0]).toMatchObject({
      status: "failed",
      lastError: expect.stringMatching(/signing.*not available to webhooks/),
    });
    expect(received).toHaveLength(0);
    asOwner(() => vault.updateSecret(id, { enabled: true }));
  });
});

describe("PagerDuty", () => {
  it("sends the routing key from the vault and resolves an incident when the run passes", async () => {
    const res = await listRoute.POST(
      request("POST", "/api/webhooks", {
        workspaceId,
        name: "PD",
        url: base + "/v2/enqueue",
        events: ["run.failed", "run.passed"],
        format: "pagerduty",
        routingKeyRef: "pd-key",
      }),
    );
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
    const hook = await res.json();
    asOwner(() => hooks.emitEvent(workspaceId, "run.failed", failed.data));
    asOwner(() => hooks.emitEvent(workspaceId, "run.passed", passed.data));
    await hooks.processDue(Date.now() + 1000);
    const bodies = received.map((r) => JSON.parse(r.body));
    expect(bodies.map((b) => b.event_action).sort()).toEqual(["resolve", "trigger"]);
    expect(
      bodies.every((b) => b.routing_key === "PD-ROUTING-KEY-0123456789" && b.dedup_key === "postbox:run:f1"),
    ).toBe(true);
    // The key is in the request only: not stored with the event, listed, audited or logged.
    const stored = JSON.stringify([
      getSqlite().prepare("SELECT payload, last_error FROM webhook_deliveries").all(),
      hooks.getWebhook(hook.id),
      queryAudit({ workspaceId, limit: 500 } as never),
    ]);
    expect(stored).not.toContain("PD-ROUTING-KEY");
    expect(
      (
        await listRoute.POST(
          request("POST", "/api/webhooks", {
            workspaceId,
            name: "PD2",
            url: base,
            events: ["run.failed"],
            format: "pagerduty",
          }),
        )
      ).status,
    ).toBe(400);
  });

  it("defaults to the public Events API address", () => {
    const hook = make({ format: "pagerduty", routingKeyRef: "pd-key", url: "" });
    expect(hook.url).toBe("https://events.pagerduty.com/v2/enqueue");
  });
});

describe("custom headers", () => {
  it("sends them, resolves vault references and never returns the values", async () => {
    const hook = make({
      headers: [
        { name: "X-Team", value: "payments" },
        { name: "Authorization", value: "Bearer {{vault:bearer}}" },
      ],
    });
    expect(hook.headers).toEqual([
      { name: "X-Team", hasValue: true },
      { name: "Authorization", hasValue: true },
    ]);
    await send(hook);
    expect(received[0].headers["x-team"]).toBe("payments");
    expect(received[0].headers.authorization).toBe("Bearer tok_header_secret_998877");
    expect(received[0].headers["postbox-signature"]).toMatch(/^t=\d+,v1=/);
    const shown = JSON.stringify([
      hooks.getWebhook(hook.id),
      hooks.listWebhooks(workspaceId),
      queryAudit({ workspaceId, limit: 500 } as never),
      getSqlite().prepare("SELECT * FROM webhook_deliveries").all(),
    ]);
    expect(shown).not.toMatch(/payments|tok_header_secret/);
    // Edits keep the list unless a new one is given.
    asOwner(() => hooks.updateWebhook(hook.id, { name: "Renamed" }));
    expect(asOwner(() => hooks.getWebhook(hook.id)).headers).toHaveLength(2);
    const cleared = asOwner(() => hooks.updateWebhook(hook.id, { headers: [] }));
    expect(cleared.headers).toEqual([]);
  });

  it("refuses headers that belong to Postbox or the transport", async () => {
    for (const name of ["Content-Type", "Postbox-Signature", "Host"]) {
      const res = await listRoute.POST(
        request("POST", "/api/webhooks", {
          workspaceId,
          name: "x",
          url: base,
          events: ["run.passed"],
          headers: [{ name, value: "x" }],
        }),
      );
      expect(res.status, name).toBe(400);
    }
  });

  it("will not send a domain-restricted vault secret to another host", async () => {
    asOwner(() =>
      vault.createSecret(workspaceId, {
        name: "pinned",
        value: "pinned-secret-value-1",
        domains: ["api.example.com"],
      }),
    );
    const hook = make({ headers: [{ name: "X-Key", value: "{{vault:pinned}}" }] });
    const out = await send(hook);
    expect(out[0]).toMatchObject({
      status: "failed",
      lastError: expect.stringMatching(/may only be sent to api\.example\.com/),
    });
    expect(received).toHaveLength(0);
    expect(JSON.stringify(out)).not.toContain("pinned-secret-value-1");
  });
});

describe("pausing after repeated failures", () => {
  it("pauses once the streak is reached, records it, and resumes on request", async () => {
    respond = 400;
    const hook = make({ pauseAfterFailures: 3 });
    for (let i = 0; i < 2; i++) await send(hook);
    expect(asOwner(() => hooks.getWebhook(hook.id))).toMatchObject({
      enabled: true,
      failureStreak: 2,
      pausedAt: null,
    });
    await send(hook);
    const paused = asOwner(() => hooks.getWebhook(hook.id));
    expect(paused).toMatchObject({ enabled: false, failureStreak: 3 });
    expect(paused.pausedAt).toBeGreaterThan(0);
    expect(paused.pauseReason).toMatch(/Paused after 3 deliveries failed in a row.*HTTP 400/);
    expect(JSON.stringify(queryAudit({ workspaceId, limit: 500 } as never))).toContain("webhook.auto-pause");
    // Nothing more is sent while paused.
    const before = received.length;
    asOwner(() => hooks.emitEvent(workspaceId, "run.failed", failed.data));
    await hooks.processDue(Date.now() + 1000);
    expect(received.length).toBe(before);
    // Turning it back on clears the pause and the streak.
    const resumed = asOwner(() => hooks.updateWebhook(hook.id, { enabled: true }));
    expect(resumed).toMatchObject({ enabled: true, failureStreak: 0, pausedAt: null, pauseReason: null });
  });

  it("counts only consecutive failures: a delivery resets the streak", async () => {
    const hook = make({ pauseAfterFailures: 3 });
    respond = 400;
    await send(hook);
    await send(hook);
    respond = 200;
    await send(hook);
    expect(asOwner(() => hooks.getWebhook(hook.id))).toMatchObject({ failureStreak: 0, enabled: true });
    respond = 400;
    await send(hook);
    await send(hook);
    expect(asOwner(() => hooks.getWebhook(hook.id)).enabled).toBe(true);
  });

  it("never pauses when the limit is 0, and retries do not count until they give up", async () => {
    respond = 400;
    const hook = make({});
    for (let i = 0; i < 5; i++) await send(hook);
    expect(asOwner(() => hooks.getWebhook(hook.id))).toMatchObject({ enabled: true, failureStreak: 5 });
    respond = 503;
    const retrying = make({ name: "Retry", pauseAfterFailures: 1 });
    const out = await send(retrying);
    expect(out[0].status).toBe("pending");
    expect(asOwner(() => hooks.getWebhook(retrying.id))).toMatchObject({ enabled: true, failureStreak: 0 });
  });
});
