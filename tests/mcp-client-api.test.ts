import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Caller } from "@/server/caller";
import type { UserRow } from "@/server/db/schema";
import { startMcpFixture } from "./helpers/mcp-server";
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-mcp-client-api-"));
process.env.DATABASE_PATH = path.join(directory, "test.db");
const repo = await import("@/server/repo"),
  users = await import("@/server/users");
const { withCaller } = await import("@/server/access-context");
const { setMember } = await import("@/server/authorize");
const service = await import("@/server/mcp-client");
const { getSqlite } = await import("@/server/db");
let owner: UserRow,
  editor: UserRow,
  viewer: UserRow,
  outsider: UserRow,
  ws: string,
  environmentId: string,
  server: Awaited<ReturnType<typeof startMcpFixture>>;
const tokens: Record<string, string> = {};
const caller = (user: UserRow): Caller => ({ kind: "user", user, via: "token" });
beforeAll(async () => {
  owner = await users.createUser({ username: "mcp-owner", password: "password123" });
  editor = await users.createUser({ username: "mcp-editor", password: "password123" });
  viewer = await users.createUser({ username: "mcp-viewer", password: "password123" });
  outsider = await users.createUser({ username: "mcp-outsider", password: "password123" });
  for (const user of [owner, editor, viewer, outsider])
    tokens[user.id] = users.createToken(user.id, "test").token;
  withCaller(caller(owner), () => {
    ws = repo.createWorkspace("MCP workspace").id;
    setMember(ws, editor.username, "editor");
    setMember(ws, viewer.username, "viewer");
    environmentId = repo.createEnvironment(ws, "MCP environment").id;
    repo.replaceVariables(ws, "environment", environmentId, [
      { key: "token", value: "runtime-secret-token", type: "secret", enabled: true },
      { key: "word", value: "Ada", type: "default", enabled: true },
    ]);
  });
  server = await startMcpFixture();
}, 15000);
afterAll(async () => {
  await server?.close();
  getSqlite().close();
  fs.rmSync(directory, { recursive: true, force: true });
});
const config = () => ({
  name: "Echo call",
  connection: {
    url: server.url + "/mcp",
    headers: [{ key: "Authorization", value: "Bearer {{token}}" }],
    timeoutMs: 1000,
  },
  action: { type: "tools/call" as const, name: "echo", arguments: { value: "{{word}}" } },
});
async function route(method: string, pathname: string, user: UserRow, body?: unknown, id = "") {
  const mod = pathname.startsWith("calls")
    ? id
      ? await import("@/app/api/mcp-client/calls/[id]/route")
      : await import("@/app/api/mcp-client/calls/route")
    : id
      ? await import("@/app/api/mcp-client/sessions/[id]/route")
      : await import("@/app/api/mcp-client/sessions/route");
  const handler = (
    mod as unknown as Record<
      string,
      (req: Request, c: { params: Promise<{ id: string }> }) => Promise<Response>
    >
  )[method];
  return handler(
    new Request(`http://localhost/api/mcp-client/${pathname}`, {
      method,
      headers: {
        authorization: `Bearer ${tokens[user.id]}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    }),
    { params: Promise.resolve({ id }) },
  );
}
describe("MCP client saved calls and user-owned sessions", () => {
  it("persists versioned templates, protects inline credentials, roles and foreign workspaces", async () => {
    const response = await route("POST", "calls", owner, { workspaceId: ws, ...config() });
    expect(response.status).toBe(201);
    const saved = await response.json();
    expect(saved.config.connection.headers[0].value).toBe("Bearer {{token}}");
    expect((await route("GET", "calls?workspaceId=" + ws, viewer)).status).toBe(200);
    expect((await route("GET", "calls/" + saved.id, outsider, undefined, saved.id)).status).toBe(404);
    expect((await route("DELETE", "calls/" + saved.id, viewer, undefined, saved.id)).status).toBe(403);
    expect(
      (
        await route(
          "PATCH",
          "calls/" + saved.id,
          owner,
          { ...config(), name: "Updated", expectedRevision: 1 },
          saved.id,
        )
      ).status,
    ).toBe(200);
    expect(
      (await route("PATCH", "calls/" + saved.id, owner, { ...config(), expectedRevision: 1 }, saved.id))
        .status,
    ).toBe(409);
    const invalid = config();
    invalid.connection.headers[0].value = "Bearer inline-secret";
    expect((await route("POST", "calls", owner, { workspaceId: ws, ...invalid })).status).toBe(400);
    expect((await route("DELETE", "calls/" + saved.id, owner, undefined, saved.id)).status).toBe(200);
    expect((await route("GET", "calls/" + saved.id, owner, undefined, saved.id)).status).toBe(404);
  });
  it("resolves active environment values, redacts echoes and prevents stolen sessions even for workspace editors", async () => {
    expect(
      (
        await route("POST", "sessions", viewer, {
          workspaceId: ws,
          environmentId,
          connection: config().connection,
        })
      ).status,
    ).toBe(403);
    const response = await route("POST", "sessions", owner, {
      workspaceId: ws,
      environmentId,
      connection: config().connection,
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const session = await response.json();
    expect(session.server.name).toBe("Fixture MCP");
    expect(
      (await route("POST", "sessions/" + session.id, editor, { action: { type: "tools/list" } }, session.id))
        .status,
    ).toBe(404);
    const result = await route(
      "POST",
      "sessions/" + session.id,
      owner,
      { action: { type: "tools/call", name: "echo", arguments: { value: "{{word}}", token: "{{token}}" } } },
      session.id,
    );
    expect(result.status).toBe(200);
    const text = await result.text();
    expect(text).toContain("Ada");
    expect(text).not.toContain("runtime-secret-token");
    expect(server.requests.some((r) => r.authorization === "Bearer runtime-secret-token")).toBe(true);
    expect(
      (
        await route(
          "POST",
          "sessions/" + session.id,
          owner,
          { action: { type: "tools/call", name: "echo", arguments: { value: "{{missing}}" } } },
          session.id,
        )
      ).status,
    ).toBe(400);
    expect(
      (await route("POST", "sessions/" + session.id, owner, { action: { type: "tools/list" } }, session.id))
        .status,
    ).toBe(200);
    expect((await route("DELETE", "sessions/" + session.id, outsider, undefined, session.id)).status).toBe(
      404,
    );
    expect((await route("DELETE", "sessions/" + session.id, owner, undefined, session.id)).status).toBe(200);
    expect(service.mcpSessionCount()).toBe(0);
    expect(server.sessions.size).toBe(0);
  });
  it("rechecks revoked workspace access and cleans up the connection", async () => {
    const response = await route("POST", "sessions", editor, {
      workspaceId: ws,
      environmentId,
      connection: config().connection,
    });
    expect(response.status).toBe(201);
    const session = await response.json();
    withCaller(caller(owner), () => setMember(ws, editor.username, "viewer"));
    expect(
      (await route("POST", "sessions/" + session.id, editor, { action: { type: "tools/list" } }, session.id))
        .status,
    ).toBe(403);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(service.mcpSessionCount()).toBe(0);
    expect(server.sessions.size).toBe(0);
  });
  it("bounds concurrent connections per owner and expires sessions without leaving remote connections", async () => {
    const opened = await Promise.allSettled(
      Array.from({ length: 11 }, () =>
        withCaller(caller(owner), () =>
          service.openMcpSession({ workspaceId: ws, environmentId, connection: config().connection }),
        ),
      ),
    );
    const sessions = opened
      .filter(
        (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof service.openMcpSession>>> =>
          r.status === "fulfilled",
      )
      .map((r) => r.value);
    expect(sessions).toHaveLength(10);
    expect(opened.filter((r) => r.status === "rejected")).toHaveLength(1);
    await Promise.all(sessions.map((s) => service.endMcpSession(s.id)));
    expect(service.mcpSessionCount()).toBe(0);
    expect(server.sessions.size).toBe(0);
    const session = await withCaller(caller(owner), () =>
      service.openMcpSession({ workspaceId: ws, environmentId, connection: config().connection }),
    );
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 11 * 60 * 1000);
    try {
      await expect(
        withCaller(caller(owner), () => service.runMcpAction(session.id, { type: "tools/list" })),
      ).rejects.toMatchObject({ status: 404 });
    } finally {
      clock.mockRestore();
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(service.mcpSessionCount()).toBe(0);
    expect(server.sessions.size).toBe(0);
  });
  it("keeps remote authentication failure separate from local login and leaks no remote diagnostic body", async () => {
    const response = await route("POST", "sessions", owner, {
      workspaceId: ws,
      connection: { url: server.url + "/auth" },
    });
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("credential-failure-secret");
    expect(service.mcpSessionCount()).toBe(0);
  });
});
