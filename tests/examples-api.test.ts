import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DEFAULT_SETTINGS, type ResponseExample } from "@/core/types";
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-examples-api-"));
process.env.DATABASE_PATH = path.join(directory, "test.db");
let repo: typeof import("@/server/repo"),
  route: typeof import("@/app/api/requests/[id]/examples/route"),
  requestRoute: typeof import("@/app/api/requests/[id]/route");
let client: Client;
const input = {
  name: "Created",
  status: 201,
  statusText: "Created",
  headers: [{ key: "Content-Type", value: "application/json", enabled: true }],
  body: '{"name":"Mochi 🐾"}',
  originalRequest: {
    method: "PATCH",
    url: "{{baseUrl}}/historical?x=1",
    params: [{ key: "x", value: "1", enabled: true }],
    headers: [],
    body: { mode: "raw" as const, language: "json" as const, raw: '{"name":"old"}' },
    auth: { type: "none" as const },
  },
};
beforeAll(async () => {
  repo = await import("@/server/repo");
  route = await import("@/app/api/requests/[id]/examples/route");
  requestRoute = await import("@/app/api/requests/[id]/route");
  const mcp = await import("@/app/api/mcp/route");
  client = new Client({ name: "examples-test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://localhost/api/mcp"), {
      fetch: async (input, init) => {
        const request = new Request(input, init);
        return request.method === "POST"
          ? mcp.POST(request)
          : request.method === "GET"
            ? mcp.GET()
            : mcp.DELETE();
      },
    }),
  );
});
afterAll(async () => {
  await client?.close();
  const { getSqlite } = await import("@/server/db");
  getSqlite().close();
  fs.rmSync(directory, { recursive: true, force: true });
});
const send = (id: string, body?: unknown, token?: string) => {
  const request = new Request(`http://localhost/api/requests/${id}/examples`, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return body
    ? route.POST(request, { params: Promise.resolve({ id }) })
    : route.GET(request, { params: Promise.resolve({ id }) });
};
function parent() {
  const ws = repo.createWorkspace("Examples");
  const folder = repo.createFolder(ws.id, null);
  const request = repo.createRequest(ws.id, folder.id, {
    name: "Current parent",
    url: "https://api.example/current",
    settings: { ...DEFAULT_SETTINGS },
  });
  return { ws, folder, request };
}
function toolJson(result: Awaited<ReturnType<Client["callTool"]>>) {
  expect(result.isError).not.toBe(true);
  return JSON.parse((result.content as { text: string }[])[0].text);
}
describe("saved examples REST/MCP and storage", () => {
  it("creates, opens, edits/renames, duplicates, reorders and deletes pairs without changing parent fields", async () => {
    const { request } = parent();
    const initial = await (await send(request.id)).json();
    expect(initial.examples).toEqual([]);
    const createdResponse = await send(request.id, {
      expectedVersion: initial.version,
      mutation: { action: "create", example: input },
    });
    expect(createdResponse.status).toBe(200);
    const created = await createdResponse.json();
    expect(created.example).toMatchObject(input);
    expect(created.example.id).toBeTruthy();
    expect(repo.getRequest(request.id)).toMatchObject({
      url: "https://api.example/current",
      name: "Current parent",
    });
    const edited = await (
      await send(request.id, {
        expectedVersion: created.version,
        mutation: {
          action: "update",
          exampleId: created.example.id,
          changes: { name: "Renamed", status: 202, body: "edited" },
        },
      })
    ).json();
    expect(edited.example).toMatchObject({
      name: "Renamed",
      status: 202,
      body: "edited",
      createdAt: created.example.createdAt,
      originalRequest: input.originalRequest,
    });
    const copied = await (
      await send(request.id, {
        expectedVersion: edited.version,
        mutation: { action: "duplicate", exampleId: edited.example.id },
      })
    ).json();
    expect(copied.examples).toHaveLength(2);
    expect(copied.example.id).not.toBe(edited.example.id);
    expect(copied.example.originalRequest).toEqual(edited.example.originalRequest);
    const ids = copied.examples.map((example: ResponseExample) => example.id).reverse();
    const reordered = await (
      await send(request.id, {
        expectedVersion: copied.version,
        mutation: { action: "reorder", exampleIds: ids },
      })
    ).json();
    expect(reordered.examples.map((e: ResponseExample) => e.id)).toEqual(ids);
    const deleted = await (
      await send(request.id, {
        expectedVersion: reordered.version,
        mutation: { action: "delete", exampleId: ids[0] },
      })
    ).json();
    expect(deleted.examples).toHaveLength(1);
    expect(deleted.examples[0].id).toBe(ids[1]);
    const missing = await send(request.id, {
      mutation: { action: "update", exampleId: ids[0], changes: { name: "gone" } },
    });
    expect(missing.status).toBe(404);
    repo.deleteRequest(request.id);
    expect((await send(request.id)).status).toBe(404);
  });
  it("rejects stale edits and invalid status/header/order/body changes atomically", async () => {
    const { request } = parent(),
      initial = await (await send(request.id)).json();
    const created = await (await send(request.id, { mutation: { action: "create", example: input } })).json();
    expect(
      (
        await send(request.id, {
          expectedVersion: initial.version,
          mutation: { action: "delete", exampleId: created.example.id },
        })
      ).status,
    ).toBe(409);
    for (const mutation of [
      { action: "update", exampleId: created.example.id, changes: { status: 600 } },
      {
        action: "update",
        exampleId: created.example.id,
        changes: { headers: [{ key: "X-Invalid", value: "one\r\nInjected: bad" }] },
      },
      {
        action: "update",
        exampleId: created.example.id,
        changes: { bodyEncoding: "base64", body: "invalid!" },
      },
      { action: "reorder", exampleIds: [] },
      { action: "reorder", exampleIds: [created.example.id, created.example.id] },
    ]) {
      expect((await send(request.id, { expectedVersion: created.version, mutation })).status).toBe(400);
      expect((await (await send(request.id)).json()).examples).toEqual(created.examples);
    }
  });
  it("redacts scoped/snapshot/response credentials and upload bytes in storage, generic PATCH and reads", async () => {
    const { ws, request } = parent();
    repo.replaceVariables(ws.id, "global", null, [
      { key: "token", value: "workspace-secret", type: "secret", enabled: true },
    ]);
    const sensitive = {
      ...input,
      body: "workspace-secret snapshot-secret cookie-secret",
      headers: [{ key: "Set-Cookie", value: "cookie-secret", enabled: true }],
      originalRequest: {
        ...input.originalRequest,
        auth: { type: "bearer", bearer: { token: "snapshot-secret" } },
        body: {
          mode: "binary",
          binary: { fileName: "payload.bin", data: Buffer.from("upload payload").toString("base64") },
        },
      },
    };
    const created = await (
      await send(request.id, { mutation: { action: "create", example: sensitive } })
    ).json();
    for (const secret of ["workspace-secret", "snapshot-secret", "cookie-secret", "dXBsb2FkIHBheWxvYWQ="])
      expect(JSON.stringify(created)).not.toContain(secret);
    expect(created.example.originalRequest.body).toMatchObject({
      mode: "binary",
      binary: { data: "", missing: true, fileName: "payload.bin" },
    });
    const patch = await requestRoute.PATCH(
      new Request(`http://localhost/api/requests/${request.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ examples: [{ ...sensitive, id: "raw-example", createdAt: 1 }] }),
      }),
      { params: Promise.resolve({ id: request.id }) },
    );
    expect(patch.status).toBe(200);
    expect(JSON.stringify(await patch.json())).not.toContain("workspace-secret");
    const { getSqlite } = await import("@/server/db");
    const row = getSqlite().prepare("SELECT examples FROM requests WHERE id = ?").get(request.id) as {
      examples: string;
    };
    expect(row.examples).not.toContain("snapshot-secret");
    expect(row.examples).not.toContain("dXBsb2FkIHBheWxvYWQ=");
    const copy = repo.duplicateRequest(request.id)!;
    expect(copy.examples?.[0]).toMatchObject({
      id: "raw-example",
      originalRequest: { body: { binary: { missing: true } } },
    });
  });
  it("offers the same operations and optimistic version through MCP", async () => {
    const { request } = parent();
    const listed = toolJson(
      await client.callTool({ name: "list_request_examples", arguments: { requestId: request.id } }),
    );
    const created = toolJson(
      await client.callTool({
        name: "manage_request_examples",
        arguments: {
          requestId: request.id,
          command: { expectedVersion: listed.version, mutation: { action: "create", example: input } },
        },
      }),
    );
    expect(created.example.originalRequest).toEqual(input.originalRequest);
    const edited = toolJson(
      await client.callTool({
        name: "manage_request_examples",
        arguments: {
          requestId: request.id,
          command: {
            expectedVersion: created.version,
            mutation: { action: "update", exampleId: created.example.id, changes: { name: "MCP name" } },
          },
        },
      }),
    );
    expect(edited.example.name).toBe("MCP name");
    const stale = await client.callTool({
      name: "manage_request_examples",
      arguments: {
        requestId: request.id,
        command: {
          expectedVersion: listed.version,
          mutation: { action: "delete", exampleId: created.example.id },
        },
      },
    });
    expect(stale.isError).toBe(true);
    const deleted = toolJson(
      await client.callTool({
        name: "manage_request_examples",
        arguments: {
          requestId: request.id,
          command: { mutation: { action: "delete", exampleId: created.example.id } },
        },
      }),
    );
    expect(deleted.examples).toEqual([]);
  });
  it("requires workspace read/write access for the new routes and tools", async () => {
    const users = await import("@/server/users"),
      { withCaller } = await import("@/server/access-context"),
      { setMember } = await import("@/server/authorize"),
      { authorizeTool } = await import("@/server/access-policy");
    const admin = await users.createUser({ username: "admin", password: "password123", isAdmin: true });
    const owner = await users.createUser({ username: "owner", password: "password123" }),
      viewer = await users.createUser({ username: "viewer", password: "password123" }),
      outsider = await users.createUser({ username: "outsider", password: "password123" });
    const ownerCaller = { kind: "user" as const, user: owner, via: "token" as const };
    const ws = withCaller(ownerCaller, () => repo.createWorkspace("Private examples"));
    withCaller(ownerCaller, () => setMember(ws.id, viewer.username, "viewer"));
    const folder = repo.createFolder(ws.id, null),
      request = repo.createRequest(ws.id, folder.id);
    const tokens = new Map(
      [owner, viewer, outsider, admin].map((user) => [user.id, users.createToken(user.id, "test").token]),
    );
    expect((await send(request.id, undefined, tokens.get(viewer.id))).status).toBe(200);
    expect(
      (await send(request.id, { mutation: { action: "create", example: input } }, tokens.get(viewer.id)))
        .status,
    ).toBe(403);
    expect((await send(request.id, undefined, tokens.get(outsider.id))).status).toBe(404);
    expect(
      (await send(request.id, { mutation: { action: "create", example: input } }, tokens.get(owner.id)))
        .status,
    ).toBe(200);
    expect(() =>
      authorizeTool({ kind: "user", user: viewer, via: "token" }, "manage_request_examples", {
        requestId: request.id,
      }),
    ).toThrow();
    expect(() =>
      authorizeTool({ kind: "user", user: outsider, via: "token" }, "list_request_examples", {
        requestId: request.id,
      }),
    ).toThrow();
  });
});
