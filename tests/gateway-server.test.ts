import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { UserRow } from "@/server/db/schema";
import type { ApiView } from "@/server/broker";
import type { Caller } from "@/server/caller";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-gateway-test-"));
process.env.DATABASE_PATH = path.join(dir, "test.db");
process.env.POSTBOX_VAULT_KEY_FILE = path.join(dir, "vault.keys.json");
process.env.GATEWAY_ENABLED = "true";
const users = await import("@/server/users"),
  repo = await import("@/server/repo"),
  gateway = await import("@/server/gateway"),
  broker = await import("@/server/broker"),
  access = await import("@/server/authorize"),
  { withCaller } = await import("@/server/access-context"),
  { getDb, getSqlite, schema } = await import("@/server/db"),
  handlers = await import("@/app/api/gateway/[id]/[[...path]]/route");
const { gatewayPolicy } = await import("@/core/gateway/model");
let owner: UserRow, editor: UserRow, viewer: UserRow, outsider: UserRow, ws: string, provider: ApiView;
let runKey: ReturnType<typeof users.createToken>,
  otherKey: ReturnType<typeof users.createToken>,
  readKey: ReturnType<typeof users.createToken>,
  viewerKey: ReturnType<typeof users.createToken>,
  outsiderKey: ReturnType<typeof users.createToken>;
let server: http.Server;
const received: {
  path: string;
  auth: string;
  body: Buffer;
  session?: string;
  metadata?: Record<string, string | string[] | undefined>;
}[] = [];
const secret = "upstream-gateway-private-credential";
const caller = (user: UserRow): Caller => ({ kind: "user", user, via: "session" });
const own = <T>(work: () => T) => withCaller(caller(owner), work);
let serial = 0;
const create = (kind: "api" | "llm" | "mcp" = "api", policy = {}, upstreamPrefix = "") =>
  own(() =>
    gateway.createGatewayRoute({
      workspaceId: ws,
      name: `Route ${++serial}`,
      apiId: provider.id,
      kind,
      enabled: true,
      upstreamPrefix,
      policy: gatewayPolicy.parse(policy),
    }),
  );
const grant = () =>
  own(() => gateway.grantGatewayProvider(provider.id, { consumerId: editor.id, tokenId: runKey.info.id }));
const invoke = (
  id: string,
  token: string,
  grantId: string,
  body?: Buffer | string,
  relative = "/ok",
  method = "POST",
  additionalHeaders: Record<string, string> = {},
) => {
  const [pathname, query = ""] = relative.split("?");
  return handlers[method as "POST"](
    new Request(`http://localhost/api/gateway/${id}${pathname}${query ? `?${query}` : ""}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "x-postbox-grant": grantId,
        "content-type": "application/json",
        ...additionalHeaders,
      },
      ...(body === undefined ? {} : { body: new Uint8Array(Buffer.from(body)) }),
    }),
    { params: Promise.resolve({ id, path: pathname.split("/").filter(Boolean) }) },
  );
};
beforeAll(async () => {
  await users.createUser({ username: "gateway-admin", password: "password123", isAdmin: true });
  owner = await users.createUser({ username: "gateway-owner", password: "password123" });
  editor = await users.createUser({ username: "gateway-editor", password: "password123" });
  viewer = await users.createUser({ username: "gateway-viewer", password: "password123" });
  outsider = await users.createUser({ username: "gateway-outsider", password: "password123" });
  ws = own(() => repo.createWorkspace("Gateway")).id;
  own(() => {
    access.setMember(ws, editor.username, "editor");
    access.setMember(ws, viewer.username, "viewer");
  });
  runKey = users.createToken(editor.id, "gateway client", null, { scope: "run" });
  otherKey = users.createToken(editor.id, "different client", null, { scope: "run" });
  readKey = users.createToken(editor.id, "read only", null, { scope: "read" });
  viewerKey = users.createToken(viewer.id, "viewer");
  outsiderKey = users.createToken(outsider.id, "outsider");
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      received.push({
        path: req.url!,
        auth: String(req.headers.authorization),
        body,
        session: String(req.headers["mcp-session-id"]),
        metadata: {
          method: req.headers["mcp-method"],
          name: req.headers["mcp-name"],
          tenant: req.headers["mcp-param-tenant"],
        },
      });
      res.setHeader("content-type", req.url === "/binary" ? "application/octet-stream" : "application/json");
      res.setHeader("mcp-session-id", "upstream-session");
      res.end(
        req.url === "/binary"
          ? body
          : JSON.stringify({ ok: true, credential: secret, body: body.toString() }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  provider = own(() =>
    gateway.createGatewayProvider({
      workspaceId: ws,
      name: "Fake provider",
      baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      secretName: "gateway-private",
      credentialValue: secret,
      injection: { type: "bearer" },
    }),
  );
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  getSqlite().close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("managed gateway", () => {
  it("uses encrypted provider credentials, model policies and bound consumer grants", async () => {
    const route = create("llm", { allowedModels: ["local"], maxOutputTokens: 17 }, "/v1");
    const access = grant();
    const response = await invoke(
      route.id,
      runKey.token,
      access.id,
      JSON.stringify({ model: "local", messages: [] }),
      "/chat/completions",
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("[redacted]");
    const seen = received.at(-1)!;
    expect(seen.path).toBe("/v1/chat/completions");
    expect(seen.auth).toBe(`Bearer ${secret}`);
    expect(seen.auth).not.toContain(runKey.token);
    expect(JSON.parse(seen.body.toString()).max_tokens).toBe(17);
    const stored = getDb().select().from(schema.vaultSecrets).all();
    expect(JSON.stringify(stored)).not.toContain(secret);
    expect(JSON.stringify(own(() => gateway.gatewaySnapshot(ws)))).not.toContain(secret);
    const before = received.length;
    expect(
      (
        await invoke(
          route.id,
          runKey.token,
          access.id,
          JSON.stringify({ model: "forbidden" }),
          "/chat/completions",
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await invoke(
          route.id,
          otherKey.token,
          access.id,
          JSON.stringify({ model: "local" }),
          "/chat/completions",
        )
      ).status,
    ).toBe(404);
    expect(received).toHaveLength(before);
  });
  it("blocks viewers, foreign users and read-only keys before upstream work", async () => {
    const route = create();
    const access = grant();
    const before = received.length;
    expect((await invoke(route.id, viewerKey.token, access.id)).status).toBe(403);
    expect((await invoke(route.id, outsiderKey.token, access.id)).status).toBe(404);
    expect((await invoke(route.id, readKey.token, access.id)).status).toBe(403);
    expect(() =>
      withCaller(caller(editor), () =>
        gateway.createGatewayRoute({ workspaceId: ws, name: "No", apiId: provider.id, kind: "api" }),
      ),
    ).toThrow();
    expect(received).toHaveLength(before);
  });
  it("enforces MCP tool rules and preserves protocol session headers", async () => {
    const route = create("mcp", { allowedMcpTools: ["read"] }, "/mcp");
    const access = grant();
    const response = await invoke(
      route.id,
      runKey.token,
      access.id,
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read" } }),
      "/",
    );
    expect(response.status).toBe(200);
    await response.text();
    expect(response.headers.get("mcp-session-id")).toBe("upstream-session");
    expect(received.at(-1)).toMatchObject({ path: "/mcp", session: "undefined" });
    const resumed = await invoke(
      route.id,
      runKey.token,
      access.id,
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read" } }),
      "/",
      "POST",
      { "mcp-session-id": "upstream-session" },
    );
    expect(resumed.status).toBe(200);
    await resumed.text();
    expect(received.at(-1)!.session).toBe("upstream-session");
    const differentGrant = grant();
    const callsBefore = received.length;
    const stolen = await invoke(
      route.id,
      runKey.token,
      differentGrant.id,
      JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "read" } }),
      "/",
      "POST",
      { "mcp-session-id": "upstream-session" },
    );
    expect(stolen.status).toBe(404);
    expect(received).toHaveLength(callsBefore);
    expect(JSON.stringify(getDb().select().from(schema.gatewaySessions).all())).not.toContain(
      "upstream-session",
    );

    const before = received.length;
    expect(
      (
        await invoke(
          route.id,
          runKey.token,
          access.id,
          JSON.stringify({ jsonrpc: "2.0", method: "tools/call", params: { name: "delete" } }),
          "/",
        )
      ).status,
    ).toBe(403);
    expect(received).toHaveLength(before);
  });
  it("forwards current MCP routing metadata and rejects mismatches or foreign origins", async () => {
    const route = create("mcp", { allowedMcpTools: ["read"] }, "/mcp");
    const access = grant();
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "read", _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } },
    });
    const headers = {
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "tools/call",
      "mcp-name": "read",
      "mcp-param-tenant": "example",
    };
    const response = await invoke(route.id, runKey.token, access.id, body, "/", "POST", headers);
    expect(response.status).toBe(200);
    await response.text();
    expect(received.at(-1)!.metadata).toEqual({ method: "tools/call", name: "read", tenant: "example" });
    const before = received.length;
    expect(
      (
        await invoke(route.id, runKey.token, access.id, body, "/", "POST", {
          ...headers,
          "mcp-name": "delete",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await invoke(route.id, runKey.token, access.id, body, "/", "POST", {
          ...headers,
          origin: "https://foreign.invalid",
        })
      ).status,
    ).toBe(403);
    expect(received).toHaveLength(before);
  });

  it("preserves binary request and response bytes", async () => {
    const route = create();
    const access = grant();
    const bytes = Buffer.from([0, 255, 128, 10, 1]);
    const response = await invoke(route.id, runKey.token, access.id, bytes, "/binary");
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    expect(received.at(-1)!.body).toEqual(bytes);
  });
  it("persists request quotas and reports retry timing without sending excess calls", async () => {
    const route = create("api", { requestsPerMinute: 1, requestsPerDay: 1 });
    const access = grant();
    const first = await invoke(route.id, runKey.token, access.id);
    expect(first.status).toBe(200);
    await first.text();
    const before = received.length;
    const next = await invoke(route.id, runKey.token, access.id);
    expect(next.status).toBe(429);
    expect(Number(next.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(received).toHaveLength(before);
    expect(own(() => gateway.getGatewayRoute(route.id)).dayUsed).toBe(1);
  });
  it("honors gateway disablement, route disablement and immediate grant revocation", async () => {
    const route = create();
    const access = grant();
    const before = received.length;
    own(() => broker.revokeAccess(access.id));
    expect((await invoke(route.id, runKey.token, access.id)).status).toBe(403);
    own(() =>
      gateway.updateGatewayRoute(route.id, {
        enabled: false,
        policy: route.policy,
        name: route.name,
        kind: route.kind,
        apiId: route.apiId,
        upstreamPrefix: route.upstreamPrefix,
      }),
    );
    expect((await invoke(route.id, runKey.token, access.id)).status).toBe(403);
    process.env.GATEWAY_ENABLED = "false";
    expect((await invoke(route.id, runKey.token, access.id)).status).toBe(503);
    process.env.GATEWAY_ENABLED = "true";
    expect(received).toHaveLength(before);
  });
  it("retains only redacted trace metadata and validates catch-all access policies", () => {
    const snapshot = own(() => gateway.gatewaySnapshot(ws));
    expect(snapshot.traces.length).toBeGreaterThan(0);
    expect(snapshot.traces.some((t) => t.code === "quota")).toBe(true);
    expect(JSON.stringify(snapshot.traces)).not.toMatch(
      /upstream-gateway-private|messages|credential|gateway client/,
    );
  });
});
