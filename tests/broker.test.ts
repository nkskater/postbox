import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { UserRow } from "@/server/db/schema";
import { evaluateCall } from "@/core/broker/grant";
import { attachCredential, consumerHeaders, redactBytes } from "@/core/broker/inject";
import { TargetError, buildTarget, normalizePrefix, parseBaseUrl, pathAllowed } from "@/core/broker/target";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-broker-"));
process.env.DATABASE_PATH = path.join(dir, "db.sqlite");
process.env.POSTBOX_VAULT_KEY_FILE = path.join(dir, "vault.keys.json");
delete process.env.POSTBOX_VAULT_KEY;
const users = await import("@/server/users");
const repo = await import("@/server/repo");
const vault = await import("@/server/vault");
const { withCaller } = await import("@/server/access-context");
const { setMember } = await import("@/server/authorize");
const { queryAudit } = await import("@/server/audit");
const apisRoute = await import("@/app/api/broker/apis/route");
const apiRoute = await import("@/app/api/broker/apis/[id]/route");
const requestRoute = await import("@/app/api/broker/apis/[id]/request/route");
const grantRoute = await import("@/app/api/broker/apis/[id]/grant/route");
const grantsRoute = await import("@/app/api/broker/grants/route");
const oneGrantRoute = await import("@/app/api/broker/grants/[id]/route");
const approveRoute = await import("@/app/api/broker/grants/[id]/approve/route");
const denyRoute = await import("@/app/api/broker/grants/[id]/deny/route");
const revokeRoute = await import("@/app/api/broker/grants/[id]/revoke/route");
const callRoute = await import("@/app/api/broker/grants/[id]/call/route");

const SECRET = "sk_live_broker_9c1e47a2d05b38f6";

describe("targets", () => {
  const base = parseBaseUrl("https://api.example.com/v1/");
  it("accepts only a clean http(s) base URL", () => {
    for (const bad of ["ftp://x.com", "https://u:p@x.com", "https://x.com/?a=1", "https://x.com/#f", "nope"])
      expect(() => parseBaseUrl(bad), bad).toThrow(TargetError);
  });

  it("builds the URL under the base path and nowhere else", () => {
    expect(buildTarget(base, "/users/1?x=2").url).toBe("https://api.example.com/v1/users/1?x=2");
    for (const bad of [
      "users",
      "//evil.test/x",
      "/a/../b",
      "/a/%2e%2e/b",
      "/a/%252e%252e/b",
      "/a\\b",
      "/a\nb",
      "/a#frag",
      "/./x",
    ])
      expect(() => buildTarget(base, bad), bad).toThrow(TargetError);
    // "@" cannot turn the path into credentials for another host.
    expect(buildTarget(base, "/@evil.test/x").url).toBe("https://api.example.com/v1/@evil.test/x");
  });

  it("matches path prefixes on segment boundaries", () => {
    expect(normalizePrefix("v1/")).toBe("/v1");
    expect(pathAllowed(["/users"], "/users")).toBe(true);
    expect(pathAllowed(["/users"], "/users/7")).toBe(true);
    expect(pathAllowed(["/users"], "/usersecrets")).toBe(false);
    expect(pathAllowed(["/users"], "/%75sers/../admin")).toBe(false);
    expect(pathAllowed([], "/anything")).toBe(true);
  });
});

describe("credential injection", () => {
  it("attaches the credential in each style", () => {
    const u = "https://a.test/x?token=mine";
    expect(attachCredential(u, [], { type: "bearer" }, "S").headers).toEqual([["Authorization", "Bearer S"]]);
    expect(attachCredential(u, [], { type: "header", name: "X-Key", prefix: "k " }, "S").headers).toEqual([
      ["X-Key", "k S"],
    ]);
    expect(attachCredential(u, [], { type: "basic", username: "u" }, "S").headers[0][1]).toBe(
      `Basic ${Buffer.from("u:S").toString("base64")}`,
    );
    // A same-named parameter from the consumer is replaced, not duplicated.
    expect(attachCredential(u, [], { type: "query", name: "token" }, "S").url).toBe(
      "https://a.test/x?token=S",
    );
  });

  it("refuses consumer headers that carry or override credentials", () => {
    for (const name of ["Authorization", "cookie", "Host", "X-Key", "Postbox-Token", "Proxy-Authorization"])
      expect(() => consumerHeaders({ [name]: "v" }, { type: "header", name: "X-Key" }), name).toThrow();
    expect(consumerHeaders({ Accept: "application/json" }, { type: "bearer" })).toEqual([
      ["Accept", "application/json"],
    ]);
  });

  it("masks every form of the secret in a body, binary included", () => {
    const body = Buffer.concat([
      Buffer.from(`{"k":"${SECRET}","u":"${encodeURIComponent("a b" + SECRET)}"}`),
      Buffer.from([0, 255]),
    ]);
    const { body: masked, redacted } = redactBytes(body, [SECRET]);
    expect(redacted).toBe(true);
    expect(masked.includes(Buffer.from(SECRET))).toBe(false);
    expect(masked.subarray(-2)).toEqual(Buffer.from([0, 255]));
  });
});

describe("call decisions", () => {
  const grant = {
    status: "approved" as const,
    consumerId: "u1",
    tokenId: null,
    methods: ["GET"],
    pathPrefixes: ["/users"],
    expiresAt: null,
  };
  const api = { enabled: true, methods: [], pathPrefixes: [] };
  const me = { id: "u1", tokenId: null };
  const get = { method: "GET" as const, path: "/users/1" };
  it("allows the right consumer inside its limits", () => {
    expect(evaluateCall(grant, api, me, get, 1)).toEqual({ ok: true });
  });
  it("checks identity before anything else", () => {
    const v = evaluateCall({ ...grant, status: "revoked" }, api, { id: "u2", tokenId: null }, get, 1);
    expect(v).toMatchObject({ ok: false, code: "caller" });
    expect(evaluateCall(grant, api, { id: null, tokenId: null }, get, 1)).toMatchObject({ code: "caller" });
  });
  it("enforces key binding, state, expiry, method and path", () => {
    expect(evaluateCall({ ...grant, tokenId: "k1" }, api, { id: "u1", tokenId: "k2" }, get, 1)).toMatchObject(
      {
        code: "caller",
      },
    );
    expect(evaluateCall({ ...grant, tokenId: "k1" }, api, { id: "u1", tokenId: "k1" }, get, 1).ok).toBe(true);
    expect(evaluateCall({ ...grant, status: "pending" }, api, me, get, 1)).toMatchObject({ code: "status" });
    expect(evaluateCall({ ...grant, expiresAt: 5 }, api, me, get, 5)).toMatchObject({ code: "expired" });
    expect(evaluateCall(grant, { ...api, enabled: false }, me, get, 1)).toMatchObject({ code: "disabled" });
    expect(evaluateCall(grant, api, me, { method: "POST", path: "/users" }, 1)).toMatchObject({
      code: "method",
    });
    expect(evaluateCall(grant, api, me, { method: "GET", path: "/admin" }, 1)).toMatchObject({
      code: "path",
    });
    expect(evaluateCall(grant, { ...api, pathPrefixes: ["/orders"] }, me, get, 1)).toMatchObject({
      code: "path",
    });
  });
});

// ------------------------------------------------------------------ service

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}
let upstream: http.Server;
let base: string;
const seen: Seen[] = [];
let owner: UserRow, alice: UserRow, bob: UserRow, outsider: UserRow;
const keys: Record<string, string> = {};
const tokenIds: Record<string, string> = {};
let workspaceId: string;
let apiId: string;

const req = (method: string, url: string, user: UserRow, body?: unknown) =>
  new Request("http://localhost" + url, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${keys[user.id]}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeAll(async () => {
  upstream = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (c: Buffer) => chunks.push(c));
    request.on("end", () => {
      seen.push({
        method: request.method!,
        url: request.url!,
        headers: request.headers,
        body: Buffer.concat(chunks).toString(),
      });
      if (request.url!.startsWith("/v1/redirect")) {
        response.writeHead(302, { Location: "http://127.0.0.1:1/elsewhere" });
        return response.end();
      }
      // An API that careless echoes what it was given.
      response.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": "sid=abc" });
      response.end(
        JSON.stringify({
          path: request.url,
          auth: request.headers.authorization,
          key: request.headers["x-api-key"],
        }),
      );
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`;

  owner = await users.createUser({ username: "owner", password: "password123" });
  alice = await users.createUser({ username: "alice", password: "password123" });
  bob = await users.createUser({ username: "bob", password: "password123" });
  outsider = await users.createUser({ username: "outsider", password: "password123" });
  for (const user of [owner, alice, bob, outsider]) {
    const created = users.createToken(user.id, "t");
    keys[user.id] = created.token;
    tokenIds[user.id] = (created as unknown as { id?: string; info?: { id: string } }).id ?? "";
  }
  const as = (user: UserRow) => ({ kind: "user" as const, user, via: "token" as const });
  workspaceId = withCaller(as(owner), () => repo.createWorkspace("Broker").id);
  withCaller(as(owner), () => {
    setMember(workspaceId, alice.username, "editor");
    setMember(workspaceId, bob.username, "editor");
    vault.createSecret(workspaceId, { name: "upstream-key", value: SECRET });
  });
  const created = await apisRoute.POST(
    req("POST", "/api/broker/apis", owner, {
      workspaceId,
      name: "Upstream",
      baseUrl: base,
      secretName: "upstream-key",
      injection: { type: "header", name: "X-Api-Key" },
    }),
  );
  expect(created.status).toBe(201);
  apiId = (await created.json()).id;
});

afterAll(async () => {
  await new Promise((resolve) => upstream?.close(resolve));
});

const urls = new Map<unknown, (id: string) => string>([
  [requestRoute, (id) => `/api/broker/apis/${id}/request`],
  [grantRoute, (id) => `/api/broker/apis/${id}/grant`],
  [approveRoute, (id) => `/api/broker/grants/${id}/approve`],
  [denyRoute, (id) => `/api/broker/grants/${id}/deny`],
  [revokeRoute, (id) => `/api/broker/grants/${id}/revoke`],
  [callRoute, (id) => `/api/broker/grants/${id}/call`],
]);
const post = (
  route: { POST: (r: Request, c: ReturnType<typeof ctx>) => Promise<Response> },
  id: string,
  user: UserRow,
  body?: unknown,
) => route.POST(req("POST", urls.get(route)!(id), user, body), ctx(id));

async function approved(user: UserRow, limits: Record<string, unknown> = {}) {
  const asked = await (await post(requestRoute, apiId, user, { reason: "tests" })).json();
  const done = await post(approveRoute, asked.id, owner, limits);
  expect(done.status).toBe(200);
  return asked.id as string;
}

describe("registering APIs", () => {
  it("never exposes the credential and is limited to owners", async () => {
    const listed = await (
      await apisRoute.GET(req("GET", `/api/broker/apis?workspaceId=${workspaceId}`, owner))
    ).json();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ secretName: "upstream-key", secretState: "ok" });
    expect(JSON.stringify(listed)).not.toContain(SECRET);
    const body = { workspaceId, name: "Other", baseUrl: base, secretName: "upstream-key" };
    expect((await apisRoute.POST(req("POST", "/api/broker/apis", alice, body))).status).toBe(403);
    expect((await apisRoute.POST(req("POST", "/api/broker/apis", outsider, body))).status).toBe(404);
  });

  it("requires a usable workspace secret for the right host", async () => {
    const make = (extra: Record<string, unknown>) =>
      apisRoute.POST(
        req("POST", "/api/broker/apis", owner, {
          workspaceId,
          name: "Tmp",
          baseUrl: base,
          secretName: "upstream-key",
          ...extra,
        }),
      );
    expect((await make({ secretName: "nope" })).status).toBe(400);
    expect((await make({ baseUrl: "https://u:p@x.test" })).status).toBe(400);
    expect((await make({ name: "Upstream" })).status).toBe(409);
    withCaller({ kind: "user", user: owner, via: "token" }, () => {
      vault.createSecret(workspaceId, { name: "scoped", value: "v-scoped-1", domains: ["only.example.com"] });
      vault.createSecret(workspaceId, { name: "personal", value: "v-personal-1", personal: true });
    });
    expect(await (await make({ secretName: "scoped" })).json()).toMatchObject({
      error: expect.stringContaining("only.example.com"),
    });
    expect((await make({ secretName: "personal" })).status).toBe(400);
  });
});

describe("access flow", () => {
  it("lets a consumer ask, an owner decide, and keeps others out of the list", async () => {
    const asked = await post(requestRoute, apiId, alice, { reason: "build job" });
    expect(asked.status).toBe(201);
    const grant = await asked.json();
    expect(grant).toMatchObject({ status: "pending", consumerName: "alice", reference: grant.id });
    // Pending access cannot be used.
    expect((await post(callRoute, grant.id, alice, { method: "GET", path: "/users" })).status).toBe(403);
    // Not twice.
    expect((await post(requestRoute, apiId, alice, {})).status).toBe(409);
    // The consumer cannot approve herself; an outsider cannot even ask.
    expect((await post(approveRoute, grant.id, alice, {})).status).toBe(403);
    expect((await post(requestRoute, apiId, outsider, {})).status).toBe(404);
    // Visibility: owner sees all, bob sees none of alice's.
    const asOwner = await (
      await grantsRoute.GET(req("GET", `/api/broker/grants?workspaceId=${workspaceId}`, owner))
    ).json();
    expect(asOwner.map((g: { id: string }) => g.id)).toContain(grant.id);
    const asBob = await (
      await grantsRoute.GET(req("GET", `/api/broker/grants?workspaceId=${workspaceId}`, bob))
    ).json();
    expect(asBob).toEqual([]);
    expect(
      (await oneGrantRoute.GET(req("GET", `/api/broker/grants/${grant.id}`, bob), ctx(grant.id))).status,
    ).toBe(404);
    expect((await post(denyRoute, grant.id, owner)).status).toBe(200);
    expect((await post(approveRoute, grant.id, owner, {})).status).toBe(409);
    // A denied consumer may ask again.
    const again = await post(requestRoute, apiId, alice, {});
    expect(again.status).toBe(201);
    await post(denyRoute, (await again.json()).id, owner);
  });
});

describe("brokered calls", () => {
  it("injects the credential and never returns it", async () => {
    seen.length = 0;
    const id = await approved(bob);
    const response = await post(callRoute, id, bob, {
      method: "GET",
      path: "/users/7?x=1",
      headers: { Accept: "application/json" },
    });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(seen).toHaveLength(1);
    expect(seen[0].headers["x-api-key"]).toBe(SECRET);
    expect(seen[0].url).toBe("/v1/users/7?x=1");
    // The upstream echoed the key back; the broker masked it and dropped cookies.
    expect(result.status).toBe(200);
    expect(result.redacted).toBe(true);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(result.body).toContain("[redacted]");
    expect(result.headers.map(([n]: string[]) => n.toLowerCase())).not.toContain("set-cookie");
    // Statuses are tracked.
    const grant = await (
      await oneGrantRoute.GET(req("GET", `/api/broker/grants/${id}`, bob), ctx(id))
    ).json();
    expect(grant.useCount).toBe(1);
    await post(revokeRoute, id, owner);
  });

  it("denies replay by another caller, even an owner, and says nothing about the grant", async () => {
    seen.length = 0;
    const id = await approved(alice);
    for (const thief of [bob, owner, outsider]) {
      const response = await post(callRoute, id, thief, { method: "GET", path: "/users" });
      expect([403, 404]).toContain(response.status);
    }
    expect((await post(callRoute, id, bob, { method: "GET", path: "/users" })).status).toBe(404);
    expect((await post(callRoute, "brk_missing", bob, { method: "GET", path: "/users" })).status).toBe(404);
    expect(seen).toHaveLength(0);
    expect((await post(callRoute, id, alice, { method: "GET", path: "/users" })).status).toBe(200);
    await post(revokeRoute, id, alice);
  });

  it("holds consumers to the approved methods, paths and headers", async () => {
    seen.length = 0;
    const id = await approved(alice, { methods: ["GET"], pathPrefixes: ["/users"] });
    const call = (body: Record<string, unknown>) => post(callRoute, id, alice, body);
    expect((await call({ method: "POST", path: "/users" })).status).toBe(403);
    expect((await call({ method: "GET", path: "/orders" })).status).toBe(403);
    expect((await call({ method: "GET", path: "/users/../orders" })).status).toBe(403);
    expect((await call({ method: "GET", path: "//evil.test/users" })).status).toBe(403);
    expect((await call({ method: "GET", path: "/users", headers: { "X-Api-Key": "mine" } })).status).toBe(
      400,
    );
    expect(
      (await call({ method: "GET", path: "/users", headers: { Authorization: "Bearer mine" } })).status,
    ).toBe(400);
    expect(seen).toHaveLength(0);
    expect((await call({ method: "GET", path: "/users" })).status).toBe(200);
    await post(revokeRoute, id, alice);
  });

  it("rejects malformed paths even when the grant has no path limits", async () => {
    const id = await approved(alice);
    seen.length = 0;
    for (const path of ["/a/../b", "//evil.test/x", "/a/%2e%2e/b", "users"])
      expect((await post(callRoute, id, alice, { method: "GET", path })).status, path).toBe(400);
    expect(seen).toHaveLength(0);
    await post(revokeRoute, id, alice);
  });

  it("does not follow redirects away from the API", async () => {
    const id = await approved(alice);
    seen.length = 0;
    const result = await (await post(callRoute, id, alice, { method: "GET", path: "/redirect" })).json();
    expect(result.status).toBe(302);
    expect(seen).toHaveLength(1);
    await post(revokeRoute, id, alice);
  });

  it("stops at once on revoke, expiry, a disabled API and a missing or disabled secret", async () => {
    const id = await approved(alice);
    const ok = () => post(callRoute, id, alice, { method: "GET", path: "/u" });
    expect((await ok()).status).toBe(200);
    // The consumer can withdraw their own access; another consumer cannot.
    expect((await post(revokeRoute, id, bob)).status).toBe(404);

    await apiRoute.PATCH(req("PATCH", `/api/broker/apis/${apiId}`, owner, { enabled: false }), ctx(apiId));
    expect((await ok()).status).toBe(403);
    await apiRoute.PATCH(req("PATCH", `/api/broker/apis/${apiId}`, owner, { enabled: true }), ctx(apiId));
    expect((await ok()).status).toBe(200);

    const secret = withCaller({ kind: "user", user: owner, via: "token" }, () =>
      vault.listSecrets(workspaceId).find((s) => s.name === "upstream-key")!,
    );
    withCaller({ kind: "user", user: owner, via: "token" }, () =>
      vault.updateSecret(secret.id, { enabled: false }),
    );
    expect((await ok()).status).toBe(409);
    withCaller({ kind: "user", user: owner, via: "token" }, () =>
      vault.updateSecret(secret.id, { enabled: true }),
    );
    expect((await ok()).status).toBe(200);

    expect((await post(revokeRoute, id, alice)).status).toBe(200);
    expect((await ok()).status).toBe(403);
    expect((await post(revokeRoute, id, alice)).status).toBe(409);

    const short = await approved(bob, { expiresInSec: 60 });
    const { getSqlite } = await import("@/server/db");
    getSqlite()
      .prepare("UPDATE broker_grants SET expires_at = ? WHERE id = ?")
      .run(Date.now() - 1, short);
    expect((await post(callRoute, short, bob, { method: "GET", path: "/u" })).status).toBe(403);
    const listed = await (
      await grantsRoute.GET(req("GET", `/api/broker/grants?workspaceId=${workspaceId}`, bob))
    ).json();
    expect(listed.find((g: { id: string }) => g.id === short).status).toBe("expired");
  });

  it("binds access to one API key when asked", async () => {
    const first = users.createToken(alice.id, "ci");
    const second = users.createToken(alice.id, "laptop");
    const send = (key: string, url: string, body: unknown) =>
      new Request("http://localhost" + url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
      });
    const asked = await requestRoute.POST(
      send(first.token, `/api/broker/apis/${apiId}/request`, { bindToKey: true }),
      ctx(apiId),
    );
    expect(asked.status).toBe(201);
    const id = (await asked.json()).id as string;
    expect((await post(approveRoute, id, owner, {})).status).toBe(200);
    const call = (key: string) =>
      callRoute.POST(send(key, `/api/broker/grants/${id}/call`, { method: "GET", path: "/u" }), ctx(id));
    expect((await call(first.token)).status).toBe(200);
    // Same person, different key: not the key this was approved for.
    expect((await call(second.token)).status).toBe(404);
    // A request that does not come from a key cannot ask for key-bound access.
    expect((await post(revokeRoute, id, owner)).status).toBe(200);
    expect(second.info.id).not.toBe(first.info.id);
  });

  it("lets an owner grant access directly, only to workspace members", async () => {
    const direct = await post(grantRoute, apiId, owner, {
      consumerId: alice.id,
      methods: ["GET"],
      expiresInSec: 3600,
    });
    expect(direct.status).toBe(201);
    const grant = await direct.json();
    expect(grant).toMatchObject({ status: "approved", consumerName: "alice", methods: ["GET"] });
    expect(grant.expiresAt).toBeGreaterThan(Date.now());
    expect((await post(grantRoute, apiId, owner, { consumerId: outsider.id })).status).toBe(400);
    expect((await post(grantRoute, apiId, alice, { consumerId: alice.id })).status).toBe(403);
    await post(revokeRoute, grant.id, owner);
  });
});

describe("audit trail", () => {
  it("records requests, decisions and calls without any secret value", () => {
    const events = withCaller(
      { kind: "user", user: owner, via: "token" },
      () => queryAudit({ workspaceId, limit: 500 }).events,
    );
    const actions = new Set(events.map((e) => e.action));
    for (const a of [
      "broker.api.create",
      "broker.access.request",
      "broker.access.approve",
      "broker.access.deny",
      "broker.access.revoke",
      "broker.access.grant",
      "broker.call",
    ])
      expect(actions.has(a), a).toBe(true);
    expect(events.some((e) => e.action === "broker.call" && e.result === "denied")).toBe(true);
    expect(JSON.stringify(events)).not.toContain(SECRET);
  });
});

describe("backups", () => {
  it("restore brings back registered APIs but not the access granted to consumers", async () => {
    const { createBackup, restoreBackup } = await import("@/server/backup");
    const { getDb, getSqlite } = await import("@/server/db");
    const id = await approved(alice);
    const backup = createBackup(getDb(), { includeSecrets: true });
    expect(backup.tables.brokerApis.map((a) => a.name)).toContain("Upstream");
    expect(JSON.stringify(backup)).not.toContain(id);
    restoreBackup(getDb(), getSqlite(), JSON.parse(JSON.stringify(backup)));
    const apis = await (
      await apisRoute.GET(req("GET", `/api/broker/apis?workspaceId=${workspaceId}`, owner))
    ).json();
    expect(apis.map((a: { name: string }) => a.name)).toContain("Upstream");
    const grants = await (
      await grantsRoute.GET(req("GET", `/api/broker/grants?workspaceId=${workspaceId}`, owner))
    ).json();
    expect(grants).toEqual([]);
    expect((await post(callRoute, id, alice, { method: "GET", path: "/u" })).status).toBe(404);
  });
});
