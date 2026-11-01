import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MAX_BODY_BYTES,
  MAX_EVENTS_PER_LISTENER,
  hashToken,
  isListenerToken,
  storableBody,
  storableHeaders,
  verifyIncoming,
  type VerificationConfig,
} from "@/core/hook-listeners";
import type { Caller } from "@/server/caller";
import type { UserRow } from "@/server/db/schema";
import { startTestServer, type TestServer } from "./helpers/server";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-hook-listeners-"));
process.env.DATABASE_PATH = path.join(dir, "db.sqlite");
process.env.PROXY_DENY_HOSTS = "blocked.example";
const users = await import("@/server/users");
const repo = await import("@/server/repo");
const hooks = await import("@/server/hook-listeners");
const { withCaller } = await import("@/server/access-context");
const { setMember } = await import("@/server/authorize");
const { getSqlite } = await import("@/server/db");
const { queryAudit } = await import("@/server/audit");
const ingestRoute = await import("@/app/hook/[token]/[[...path]]/route");
const listRoute = await import("@/app/api/hook-listeners/route");
const oneRoute = await import("@/app/api/hook-listeners/[id]/route");
const rotateRoute = await import("@/app/api/hook-listeners/[id]/rotate/route");
const eventsRoute = await import("@/app/api/hook-listeners/[id]/events/route");
const replayRoute = await import("@/app/api/hook-listeners/[id]/replay/route");

const caller = (user: UserRow): Caller => ({ kind: "user", user, via: "token" });
const body = (text: string) => Buffer.from(text);
const at = Date.UTC(2026, 0, 1);

// ------------------------------------------------------------------ pure rules

describe("verification", () => {
  const payload = body('{"a":1}');
  const hmac = (secret: string, data: Buffer | string, encoding: "hex" | "base64" = "hex") =>
    createHmac("sha256", secret).update(data).digest(encoding);

  it("verifies shared tokens in constant time", () => {
    const config: VerificationConfig = { type: "token", header: "X-Token" };
    expect(verifyIncoming(config, "s3cret", { "x-token": "s3cret" }, payload, at)).toBe("valid");
    expect(verifyIncoming(config, "s3cret", { "x-token": "s3cre" }, payload, at)).toBe("invalid");
    expect(verifyIncoming(config, "s3cret", {}, payload, at)).toBe("missing");
  });

  it("verifies GitHub-style HMAC of the raw bytes, hex or base64", () => {
    const github: VerificationConfig = {
      type: "hmac",
      header: "X-Hub-Signature-256",
      encoding: "hex",
      prefix: "sha256=",
    };
    const good = { "x-hub-signature-256": `sha256=${hmac("k", payload)}` };
    expect(verifyIncoming(github, "k", good, payload, at)).toBe("valid");
    expect(verifyIncoming(github, "other", good, payload, at)).toBe("invalid");
    expect(verifyIncoming(github, "k", good, body('{"a":2}'), at)).toBe("invalid");
    expect(verifyIncoming(github, "k", { "x-hub-signature-256": hmac("k", payload) }, payload, at)).toBe(
      "invalid",
    );
    expect(verifyIncoming(github, "k", { "x-hub-signature-256": "sha256=zz" }, payload, at)).toBe("invalid");
    const b64: VerificationConfig = { type: "hmac", header: "X-Sig", encoding: "base64", prefix: "" };
    expect(verifyIncoming(b64, "k", { "x-sig": hmac("k", payload, "base64") }, payload, at)).toBe("valid");
    // Non-UTF-8 bytes are signed as bytes.
    const binary = Buffer.from([0xff, 0xfe, 0x00, 0x80]);
    expect(
      verifyIncoming(github, "k", { "x-hub-signature-256": `sha256=${hmac("k", binary)}` }, binary, at),
    ).toBe("valid");
  });

  it("verifies timestamped signatures and refuses stale or malformed ones", () => {
    const config: VerificationConfig = { type: "timestamped", header: "Stripe-Signature" };
    const t = Math.floor(at / 1000);
    const header = (time: number, data = payload) =>
      `t=${time},v1=${createHmac("sha256", "k").update(`${time}.`).update(data).digest("hex")}`;
    expect(verifyIncoming(config, "k", { "stripe-signature": header(t) }, payload, at)).toBe("valid");
    expect(verifyIncoming(config, "k", { "stripe-signature": header(t - 301) }, payload, at)).toBe("invalid");
    expect(verifyIncoming(config, "k", { "stripe-signature": header(t, body("x")) }, payload, at)).toBe(
      "invalid",
    );
    for (const garbage of ["", "t=1", "v1=abc", "t=NaN,v1=" + "0".repeat(64), `t=${t},v1=short`])
      expect(verifyIncoming(config, "k", { "stripe-signature": garbage }, payload, at)).not.toBe("valid");
  });

  it("does nothing when verification is off", () => {
    expect(verifyIncoming({ type: "none" }, "", {}, payload, at)).toBe("none");
  });
});

describe("storage rules", () => {
  it("redacts credentials, including a shared-token header, and bounds headers", () => {
    const stored = storableHeaders(
      [
        ["Authorization", "Bearer abc"],
        ["Cookie", "sid=1"],
        ["X-Token", "s3cret"],
        ["X-Other", "fine"],
      ],
      { type: "token", header: "x-token" },
    );
    expect(stored).toEqual([
      ["authorization", "[redacted]"],
      ["cookie", "[redacted]"],
      ["x-token", "[redacted]"],
      ["x-other", "fine"],
    ]);
    const many = storableHeaders(
      Array.from({ length: 500 }, (_, i) => [`h${i}`, "x".repeat(5000)]),
      {
        type: "none",
      },
    );
    expect(many).toHaveLength(100);
    expect(many[0][1]).toHaveLength(2000);
  });

  it("keeps valid UTF-8 as text and anything else as base64", () => {
    expect(storableBody(body("héllo"))).toEqual({ text: "héllo", encoding: "utf8" });
    const binary = Buffer.from([0xff, 0xfe, 0x00]);
    expect(storableBody(binary)).toEqual({ text: binary.toString("base64"), encoding: "base64" });
  });

  it("recognises well-formed tokens only", () => {
    expect(isListenerToken("hk_" + "a".repeat(32))).toBe(true);
    for (const bad of [
      "",
      "hk_",
      "hk_short",
      "x_" + "a".repeat(32),
      "hk_" + "a/b".repeat(10),
      "hk_" + "a".repeat(200),
    ])
      expect(isListenerToken(bad)).toBe(false);
  });
});

// ------------------------------------------------------------------ the running service

let owner: UserRow, editor: UserRow, outsider: UserRow;
let workspaceId: string;
let local: TestServer;
const keys: Record<string, string> = {};

const api = async (
  handler: (...args: never[]) => Promise<Response>,
  url: string,
  init: { method?: string; key?: string | null; body?: unknown; id?: string } = {},
) => {
  const key = init.key === undefined ? keys[owner.id] : init.key;
  const response = await (handler as unknown as (request: Request, ctx: unknown) => Promise<Response>)(
    new Request(`http://localhost${url}`, {
      method: init.method ?? "GET",
      headers: {
        ...(key ? { authorization: `Bearer ${key}` } : {}),
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
    { params: Promise.resolve({ id: init.id ?? "" }) },
  );
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : undefined };
};

/** Send a request to the public ingest route the way a provider would. */
async function deliver(
  token: string,
  init: { method?: string; body?: string | Buffer; headers?: Record<string, string>; suffix?: string } = {},
) {
  const response = await ingestRoute.POST(
    new Request(`http://localhost/hook/${token}${init.suffix ?? ""}`, {
      method: init.method ?? "POST",
      headers: init.headers,
      body: init.body as BodyInit | undefined,
    }),
    { params: Promise.resolve({ token, path: undefined }) },
  );
  return { status: response.status, text: await response.text(), headers: response.headers };
}

async function create(extra: Record<string, unknown> = {}) {
  const created = await api(listRoute.POST, "/api/hook-listeners", {
    method: "POST",
    body: { workspaceId, name: "Listener", ...extra },
  });
  expect(created.status, JSON.stringify(created.data)).toBe(201);
  return created.data as { id: string; token: string; path: string };
}

beforeAll(async () => {
  local = await startTestServer();
  owner = await users.createUser({ username: "owner", password: "password123" });
  editor = await users.createUser({ username: "editor", password: "password123" });
  outsider = await users.createUser({ username: "outsider", password: "password123" });
  for (const user of [owner, editor, outsider]) keys[user.id] = users.createToken(user.id, "t").token;
  workspaceId = withCaller(caller(owner), () => repo.createWorkspace("Hooks").id);
  withCaller(caller(owner), () => setMember(workspaceId, editor.username, "editor"));
});
afterAll(async () => {
  await local.close();
});

describe("listener lifecycle", () => {
  it("creates a listener, shows its URL once and never lists the token or secret", async () => {
    const created = await create({
      verification: { type: "token", header: "X-Token" },
      secret: "shared-secret-value",
    });
    expect(created.path).toBe(`/hook/${created.token}`);
    expect(isListenerToken(created.token)).toBe(true);
    const listed = await api(listRoute.GET, `/api/hook-listeners?workspaceId=${workspaceId}`);
    const text = JSON.stringify(listed.data);
    expect(text).not.toContain(created.token);
    expect(text).not.toContain("shared-secret-value");
    expect(text).not.toContain(hashToken(created.token));
    expect(listed.data[0]).toMatchObject({ hasSecret: true, tokenHint: created.token.slice(-4) });
    const stored = getSqlite()
      .prepare("SELECT token_hash FROM hook_listeners WHERE id = ?")
      .get(created.id) as {
      token_hash: string;
    };
    expect(stored.token_hash).toBe(hashToken(created.token));
    expect(JSON.stringify(stored)).not.toContain(created.token);
  });

  it("validates configuration", async () => {
    const bad = async (extra: Record<string, unknown>) =>
      (
        await api(listRoute.POST, "/api/hook-listeners", {
          method: "POST",
          body: { workspaceId, name: "x", ...extra },
        })
      ).status;
    expect(await bad({ verification: { type: "token", header: "X-Token" } })).toBe(400);
    expect(await bad({ verification: { type: "token", header: "bad header" }, secret: "s" })).toBe(400);
    expect(await bad({ response: { status: 302, contentType: "text/plain", body: "" } })).toBe(400);
    expect(await bad({ response: { status: 200, contentType: "text/html\r\nX-Evil: 1", body: "" } })).toBe(
      400,
    );
    expect(await bad({ response: { status: 200, contentType: "text/plain", body: "x".repeat(5000) } })).toBe(
      400,
    );
    expect(await bad({ ratePerMinute: 0 })).toBe(400);
    expect(await bad({ unknown: true })).toBe(400);
    expect(await bad({ forwardUrl: "ftp://example.test/x" })).toBe(400);
    expect(await bad({ forwardUrl: "http://blocked.example/x" })).toBe(400);
  });

  it("caps listeners per workspace", async () => {
    const other = withCaller(caller(owner), () => repo.createWorkspace("Many").id);
    for (let i = 0; i < 20; i++) hooks.createListener(other, hooks.listenerInput.parse({ name: `l${i}` }));
    expect(() => hooks.createListener(other, hooks.listenerInput.parse({ name: "one more" }))).toThrow(
      /at most 20/,
    );
  });

  it("pauses, resumes, rotates and revokes", async () => {
    const created = await create();
    expect((await deliver(created.token, { body: "a" })).status).toBe(200);

    await api(oneRoute.PATCH, `/api/hook-listeners/${created.id}`, {
      method: "PATCH",
      id: created.id,
      body: { status: "paused" },
    });
    const paused = await deliver(created.token, { body: "b" });
    expect(paused.status).toBe(503);
    expect(paused.headers.get("retry-after")).toBe("300");

    await api(oneRoute.PATCH, `/api/hook-listeners/${created.id}`, {
      method: "PATCH",
      id: created.id,
      body: { status: "active" },
    });
    expect((await deliver(created.token, { body: "c" })).status).toBe(200);

    const rotated = await api(rotateRoute.POST, `/api/hook-listeners/${created.id}/rotate`, {
      method: "POST",
      id: created.id,
    });
    expect(rotated.data.token).not.toBe(created.token);
    expect((await deliver(created.token, { body: "old" })).status).toBe(404);
    expect((await deliver(rotated.data.token, { body: "new" })).status).toBe(200);

    await api(oneRoute.PATCH, `/api/hook-listeners/${created.id}`, {
      method: "PATCH",
      id: created.id,
      body: { status: "revoked" },
    });
    expect((await deliver(rotated.data.token)).status).toBe(404);
    const again = await api(oneRoute.PATCH, `/api/hook-listeners/${created.id}`, {
      method: "PATCH",
      id: created.id,
      body: { status: "active" },
    });
    expect(again.status).toBe(409);
    // Events survive revocation for inspection.
    const events = await api(eventsRoute.GET, `/api/hook-listeners/${created.id}/events`, { id: created.id });
    expect(events.data).toHaveLength(3);
  });
});

describe("receiving", () => {
  it("records method, path, query, headers and body, and answers with the configured response", async () => {
    const created = await create({
      response: { status: 202, contentType: "text/plain", body: "thanks" },
    });
    const result = await deliver(created.token, {
      method: "PUT",
      suffix: "/orders/7?x=1&y=2",
      body: '{"id":7}',
      headers: { "content-type": "application/json", "x-custom": "yes", authorization: "Bearer topsecret" },
    });
    expect(result).toMatchObject({ status: 202, text: "thanks" });
    expect(result.headers.get("content-type")).toBe("text/plain");
    expect(result.headers.get("x-content-type-options")).toBe("nosniff");
    expect(result.headers.get("content-security-policy")).toContain("sandbox");

    const list = await api(eventsRoute.GET, `/api/hook-listeners/${created.id}/events`, { id: created.id });
    expect(list.data[0]).toMatchObject({
      method: "PUT",
      path: "/orders/7",
      query: "x=1&y=2",
      signature: "none",
      responseStatus: 202,
      bodyBytes: 8,
    });
    expect(JSON.stringify(list.data)).not.toContain("topsecret");
    expect(list.data[0]).not.toHaveProperty("body");
    const one = await api(
      eventsRoute.GET,
      `/api/hook-listeners/${created.id}/events?event=${list.data[0].id}`,
      {
        id: created.id,
      },
    );
    expect(one.data).toMatchObject({ body: '{"id":7}', bodyEncoding: "utf8" });
    expect(one.data.headers).toContainEqual(["x-custom", "yes"]);
    expect(one.data.headers).toContainEqual(["authorization", "[redacted]"]);
    const view = await api(oneRoute.GET, `/api/hook-listeners/${created.id}`, { id: created.id });
    expect(view.data.receivedCount).toBe(1);
  });

  it("rejects missing and wrong signatures with 401 but keeps them for debugging", async () => {
    const created = await create({
      verification: { type: "hmac", header: "X-Hub-Signature-256", encoding: "hex", prefix: "sha256=" },
      secret: "hook-secret",
    });
    const payload = '{"zen":"ok"}';
    const sign = (secret: string) => `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
    expect((await deliver(created.token, { body: payload })).status).toBe(401);
    const wrong = await deliver(created.token, {
      body: payload,
      headers: { "x-hub-signature-256": sign("nope") },
    });
    expect(wrong.status).toBe(401);
    expect(wrong.text).not.toContain("hook-secret");
    const good = await deliver(created.token, {
      body: payload,
      headers: { "x-hub-signature-256": sign("hook-secret") },
    });
    expect(good.status).toBe(200);
    const signatures = (
      await api(eventsRoute.GET, `/api/hook-listeners/${created.id}/events`, { id: created.id })
    ).data.map((event: { signature: string }) => event.signature);
    expect(signatures.sort()).toEqual(["invalid", "missing", "valid"]);
  });

  it("answers unknown, malformed and revoked tokens identically", async () => {
    const outcomes = await Promise.all(
      ["hk_" + "A".repeat(32), "hk_short", "nonsense", "../etc/passwd", "hk_" + "a/b".repeat(10)].map(
        (token) => deliver(token, { body: "x" }),
      ),
    );
    for (const outcome of outcomes)
      expect(outcome).toMatchObject({ status: 404, text: '{"error":"Not found"}' });
  });

  it("refuses oversized bodies without storing them", async () => {
    const created = await create();
    const huge = Buffer.alloc(MAX_BODY_BYTES + 1, 97);
    expect((await deliver(created.token, { body: huge })).status).toBe(413);
    // A lying Content-Length is refused before the body is read at all.
    const lied = await deliver(created.token, {
      body: "x",
      headers: { "content-length": String(MAX_BODY_BYTES * 4) },
    });
    expect(lied.status).toBe(413);
    const ok = await deliver(created.token, { body: Buffer.alloc(MAX_BODY_BYTES, 97) });
    expect(ok.status).toBe(200);
    const events = (
      await api(eventsRoute.GET, `/api/hook-listeners/${created.id}/events`, { id: created.id })
    ).data;
    expect(events).toHaveLength(1);
    expect(events[0].bodyBytes).toBe(MAX_BODY_BYTES);
  });

  it("rate limits per listener and leaves other listeners alone", async () => {
    const limited = await create({ ratePerMinute: 3 });
    const other = await create({ ratePerMinute: 3 });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await deliver(limited.token, { body: String(i) })).status);
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
    expect((await deliver(other.token, { body: "fine" })).status).toBe(200);
    const events = (
      await api(eventsRoute.GET, `/api/hook-listeners/${limited.id}/events`, { id: limited.id })
    ).data;
    expect(events).toHaveLength(3);
  });

  it("stores hostile payloads as inert text and never reflects them", async () => {
    const created = await create({ response: { status: 200, contentType: "text/plain", body: "ok" } });
    const script = "<script>alert(1)</script>\"'`${{7*7}}\u0000‮";
    const result = await deliver(created.token, {
      method: "POST",
      suffix: "/%3Cscript%3E/..%2f..%2f",
      body: script,
      headers: { "x-evil": "a\tb", "content-type": "text/html" },
    });
    expect(result.text).toBe("ok");
    const [event] = (
      await api(eventsRoute.GET, `/api/hook-listeners/${created.id}/events`, { id: created.id })
    ).data;
    const one = await api(eventsRoute.GET, `/api/hook-listeners/${created.id}/events?event=${event.id}`, {
      id: created.id,
    });
    expect(one.data.body).toBe(script);
    // Binary payloads survive losslessly.
    const binary = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x80]);
    await deliver(created.token, { body: binary });
    const latest = (
      await api(eventsRoute.GET, `/api/hook-listeners/${created.id}/events`, { id: created.id })
    ).data[0];
    const bin = await api(eventsRoute.GET, `/api/hook-listeners/${created.id}/events?event=${latest.id}`, {
      id: created.id,
    });
    expect(bin.data.bodyEncoding).toBe("base64");
    expect(Buffer.from(bin.data.body, "base64").equals(binary)).toBe(true);
  });

  it("keeps only the newest events per listener and prunes by age", async () => {
    const created = await create({ ratePerMinute: 6000 });
    for (let i = 0; i < MAX_EVENTS_PER_LISTENER + 15; i++) await deliver(created.token, { body: String(i) });
    const events = (
      await api(eventsRoute.GET, `/api/hook-listeners/${created.id}/events?limit=200`, { id: created.id })
    ).data;
    expect(events).toHaveLength(MAX_EVENTS_PER_LISTENER);
    hooks.pruneHookEvents(1, Date.now() + 2 * 86_400_000);
    expect(hooks.listEvents(created.id)).toHaveLength(0);
    const kept = await create();
    await deliver(kept.token, { body: "x" });
    hooks.pruneHookEvents(0, Date.now() + 9999 * 86_400_000);
    expect(hooks.listEvents(kept.id)).toHaveLength(1);
    await api(eventsRoute.DELETE, `/api/hook-listeners/${kept.id}/events`, { method: "DELETE", id: kept.id });
    expect(hooks.listEvents(kept.id)).toHaveLength(0);
  });
});

describe("forwarding and replay", () => {
  const settle = async (listenerId: string) => {
    for (let i = 0; i < 100; i++) {
      const [event] = hooks.listEvents(listenerId);
      if (event?.forwardedAt) return event;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("forward did not finish");
  };

  it("forwards verified requests only, and never replays by itself", async () => {
    const created = await create({
      forwardUrl: `${local.url}/echo`,
      verification: { type: "token", header: "X-Token" },
      secret: "tok",
    });
    const before = local.requests.length;
    await deliver(created.token, { body: "bad", headers: { "x-token": "wrong" } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(local.requests.length).toBe(before);

    await deliver(created.token, {
      body: '{"hello":"world"}',
      headers: { "x-token": "tok", "content-type": "application/json", authorization: "Bearer leak" },
    });
    const event = await settle(created.id);
    expect(event).toMatchObject({ forwardStatus: 200, forwardError: null, replays: 0 });
    const sent = local.requests.at(-1)!;
    expect(sent.body).toBe('{"hello":"world"}');
    expect(sent.headers["postbox-listener"]).toBe(created.id);
    expect(sent.headers["postbox-event-id"]).toBe(event.id);
    expect(sent.headers.authorization).toBeUndefined();
    expect(sent.headers["x-token"]).toBeUndefined();

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(local.requests.filter((request) => request.headers["postbox-event-id"] === event.id)).toHaveLength(
      1,
    );

    const replay = await api(replayRoute.POST, `/api/hook-listeners/${created.id}/replay`, {
      method: "POST",
      id: created.id,
      body: { eventId: event.id },
    });
    expect(replay.data).toEqual({ status: 200, error: null });
    expect(local.requests.at(-1)!.headers["postbox-replay"]).toBe("true");
    expect(hooks.listEvents(created.id)[0].replays).toBe(1);
  });

  it("replays to an explicit target, subject to the outbound policy", async () => {
    const created = await create();
    await deliver(created.token, { body: "payload" });
    const [event] = hooks.listEvents(created.id);
    const none = await api(replayRoute.POST, `/api/hook-listeners/${created.id}/replay`, {
      method: "POST",
      id: created.id,
      body: { eventId: event.id },
    });
    expect(none.status).toBe(400);
    const blocked = await api(replayRoute.POST, `/api/hook-listeners/${created.id}/replay`, {
      method: "POST",
      id: created.id,
      body: { eventId: event.id, url: "http://blocked.example/x" },
    });
    expect(blocked.status).toBe(400);
    const ok = await api(replayRoute.POST, `/api/hook-listeners/${created.id}/replay`, {
      method: "POST",
      id: created.id,
      body: { eventId: event.id, url: `${local.url}/echo` },
    });
    expect(ok.data).toEqual({ status: 200, error: null });
    const missing = await api(replayRoute.POST, `/api/hook-listeners/${created.id}/replay`, {
      method: "POST",
      id: created.id,
      body: { eventId: "nope", url: `${local.url}/echo` },
    });
    expect(missing.status).toBe(404);
  });

  it("does not follow redirects or leak them as success", async () => {
    const created = await create({ forwardUrl: `${local.url}/redirect?n=1` });
    await deliver(created.token, { body: "x" });
    const event = await settle(created.id);
    expect(event.forwardStatus).toBeGreaterThanOrEqual(300);
    expect(event.forwardStatus).toBeLessThan(400);
  });
});

describe("access", () => {
  it("lets only workspace owners manage listeners", async () => {
    const created = await create();
    const asEditor = (
      handler: Parameters<typeof api>[0],
      url: string,
      init: Parameters<typeof api>[2] = {},
    ) => api(handler, url, { ...init, key: keys[editor.id] });
    const asOutsider = (
      handler: Parameters<typeof api>[0],
      url: string,
      init: Parameters<typeof api>[2] = {},
    ) => api(handler, url, { ...init, key: keys[outsider.id] });
    expect((await asEditor(listRoute.GET, `/api/hook-listeners?workspaceId=${workspaceId}`)).status).toBe(
      403,
    );
    expect(
      (
        await asEditor(oneRoute.PATCH, `/api/hook-listeners/${created.id}`, {
          method: "PATCH",
          id: created.id,
          body: { name: "x" },
        })
      ).status,
    ).toBe(403);
    expect(
      (await asOutsider(eventsRoute.GET, `/api/hook-listeners/${created.id}/events`, { id: created.id }))
        .status,
    ).toBe(404);
    expect(
      (await api(listRoute.GET, `/api/hook-listeners?workspaceId=${workspaceId}`, { key: null })).status,
    ).toBe(401);
  });

  it("audits changes without tokens, secrets or payloads", async () => {
    const created = await create({ verification: { type: "token", header: "X-T" }, secret: "audit-me-not" });
    await deliver(created.token, { body: "payload-body", headers: { "x-t": "audit-me-not" } });
    await api(oneRoute.PATCH, `/api/hook-listeners/${created.id}`, {
      method: "PATCH",
      id: created.id,
      body: { secret: "another-secret", status: "paused" },
    });
    const entries = queryAudit({ workspaceId, limit: 200 } as never) as unknown as { events?: unknown[] };
    const text = JSON.stringify(entries);
    expect(text).toContain("hookListener");
    for (const forbidden of [created.token, "audit-me-not", "another-secret", "payload-body"])
      expect(text).not.toContain(forbidden);
  });

  it("deletes a listener with its events and frees its URL", async () => {
    const created = await create();
    await deliver(created.token, { body: "x" });
    await api(oneRoute.DELETE, `/api/hook-listeners/${created.id}`, { method: "DELETE", id: created.id });
    expect((await deliver(created.token)).status).toBe(404);
    const left = getSqlite()
      .prepare("SELECT COUNT(*) AS n FROM hook_events WHERE listener_id = ?")
      .get(created.id) as {
      n: number;
    };
    expect(left.n).toBe(0);
  });
});
