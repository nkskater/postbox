import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startTestServer, type TestServer } from "./helpers/server";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-mcp-test-"));
process.env.DATABASE_PATH = path.join(dir, "mcp-test.db");

type McpRoute = typeof import("@/app/api/mcp/route");
let mcpRoute: McpRoute;
let server: TestServer;
let client: Client;
let transport: StreamableHTTPClientTransport;

function parseToolJson<T = Record<string, unknown>>(result: Awaited<ReturnType<Client["callTool"]>>): T {
  const first = (result.content as { type: string; text?: string }[])[0];
  expect(first?.type).toBe("text");
  return JSON.parse(first.text!) as T;
}

beforeAll(async () => {
  mcpRoute = await import("@/app/api/mcp/route");
  server = await startTestServer();

  const customFetch: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const req = new Request(url, init);
    const method = req.method.toUpperCase();
    if (method === "POST") return mcpRoute.POST(req);
    if (method === "GET") return mcpRoute.GET();
    if (method === "DELETE") return mcpRoute.DELETE();
    if (method === "OPTIONS") return mcpRoute.OPTIONS();
    return new Response("Method Not Allowed", { status: 405 });
  };

  transport = new StreamableHTTPClientTransport(new URL("http://localhost:3000/api/mcp"), {
    fetch: customFetch,
  });
  client = new Client({ name: "postbox-test-client", version: "1.0.0" });
  await client.connect(transport);
});

afterAll(async () => {
  await client?.close();
  await server?.close();
});

describe("MCP server (/api/mcp)", () => {
  it("lists all Postbox tools and resources", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "list_workspaces",
        "create_workspace",
        "rename_workspace",
        "delete_workspace",
        "get_workspace_tree",
        "get_folder",
        "create_folder",
        "update_folder",
        "delete_folder",
        "duplicate_folder",
        "get_request",
        "create_request",
        "update_request",
        "delete_request",
        "duplicate_request",
        "move_tree_item",
        "send_request",
        "generate_code_snippet",
        "run_collection",
        "list_runs",
        "get_run",
        "delete_run",
        "list_environments",
        "get_environment",
        "create_environment",
        "rename_environment",
        "delete_environment",
        "list_variables",
        "set_variables",
        "import_spec",
        "export_collection",
        "export_environment",
        "list_history",
        "get_history_entry",
        "clear_history",
        "list_cookies",
        "clear_cookies",
      ]),
    );

    const { resources } = await client.listResources();
    expect(resources.some((r) => r.uri === "postbox://workspaces")).toBe(true);
    expect(resources.some((r) => r.uri.startsWith("postbox://workspaces/"))).toBe(true);
  });

  it("manages workspaces, environments, variables, collections, requests, and executes requests & runs", async () => {
    // 1. Create workspace
    const ws = parseToolJson<{ id: string; name: string }>(
      await client.callTool({ name: "create_workspace", arguments: { name: "MCP Workspace" } }),
    );
    expect(ws.name).toBe("MCP Workspace");

    // 2. Create environment & set variables (including a secret)
    const env = parseToolJson<{
      id: string;
      name: string;
      variables: { key: string; value: string; type: string }[];
    }>(
      await client.callTool({
        name: "create_environment",
        arguments: {
          workspaceId: ws.id,
          name: "Staging",
          variables: [
            { key: "base_url", value: server.url, type: "default", enabled: true },
            { key: "api_key", value: "super-secret-token", type: "secret", enabled: true },
          ],
        },
      }),
    );
    expect(env.name).toBe("Staging");
    // Secret value is masked by default
    expect(env.variables.find((v) => v.key === "api_key")?.value).toBe("••••••••");

    // Merge an additional variable into the environment
    const mergedVars = parseToolJson<{ variables: { key: string; value: string }[] }>(
      await client.callTool({
        name: "set_variables",
        arguments: {
          scope: "environment",
          ownerId: env.id,
          mode: "merge",
          variables: [{ key: "greeting", value: "hello-mcp", type: "default", enabled: true }],
        },
      }),
    );
    expect(mergedVars.variables).toHaveLength(3);

    // Verify includeSecrets: true returns the real value
    const unmasked = parseToolJson<{ variables: { key: string; value: string }[] }>(
      await client.callTool({
        name: "list_variables",
        arguments: { scope: "environment", ownerId: env.id, includeSecrets: true },
      }),
    );
    expect(unmasked.variables.find((v) => v.key === "api_key")?.value).toBe("super-secret-token");

    // 3. Create a collection with inherited Bearer auth
    const col = parseToolJson<{ id: string; name: string }>(
      await client.callTool({
        name: "create_folder",
        arguments: {
          workspaceId: ws.id,
          name: "Echo API",
          auth: { type: "bearer", bearer: { token: "{{api_key}}" } },
        },
      }),
    );
    expect(col.name).toBe("Echo API");

    // 4. Create a saved request via structured arguments
    const req1 = parseToolJson<{ id: string; name: string; method: string; url: string }>(
      await client.callTool({
        name: "create_request",
        arguments: {
          folderId: col.id,
          name: "Echo Greeting",
          method: "POST",
          url: "{{base_url}}/echo?msg={{greeting}}",
          body: { mode: "raw", raw: '{"sentBy":"mcp"}', language: "json" },
          headers: [{ key: "Content-Type", value: "application/json", enabled: true }],
          testScript: `
            pm.test("status is 200", () => pm.response.to.have.status(200));
            pm.test("greeting query matches", () => {
              pm.expect(pm.response.json().query.msg).to.equal("hello-mcp");
            });
          `,
        },
      }),
    );
    expect(req1.method).toBe("POST");

    // 5. Create a second request from a cURL command
    const req2 = parseToolJson<{ id: string; name: string; method: string }>(
      await client.callTool({
        name: "create_request",
        arguments: {
          folderId: col.id,
          name: "Status 201 via cURL",
          curl: `curl -X GET '${server.url}/status?code=201' -H 'X-Custom: from-curl'`,
          testScript: `pm.test("is 201", () => pm.response.to.have.status(201));`,
        },
      }),
    );
    expect(req2.method).toBe("GET");

    // 6. Generate code snippet with variable resolution
    const snippet = parseToolJson<{ language: string; snippet: string; unresolvedVariables: string[] }>(
      await client.callTool({
        name: "generate_code_snippet",
        arguments: {
          language: "curl",
          requestId: req1.id,
          environmentId: env.id,
        },
      }),
    );
    expect(snippet.snippet).toContain(`${server.url}/echo?msg=hello-mcp`);
    expect(snippet.snippet).toContain("Bearer super-secret-token");
    expect(snippet.unresolvedVariables).toEqual([]);

    // 7. Execute saved request via send_request
    const execRes = parseToolJson<{
      passed: boolean;
      response: { status: number; bodyText: string };
      tests: { name: string; passed: boolean }[];
      historyId: string;
    }>(
      await client.callTool({
        name: "send_request",
        arguments: {
          requestId: req1.id,
          environmentId: env.id,
        },
      }),
    );
    expect(execRes.passed).toBe(true);
    expect(execRes.response.status).toBe(200);
    expect(execRes.tests).toHaveLength(2);
    expect(execRes.tests.every((t) => t.passed)).toBe(true);
    const echoed = JSON.parse(execRes.response.bodyText);
    expect(echoed.headers.authorization).toBe("Bearer super-secret-token");
    expect(JSON.parse(echoed.body)).toEqual({ sentBy: "mcp" });

    // Check history was recorded
    const history = parseToolJson<{ history: { id: string }[] }>(
      await client.callTool({ name: "list_history", arguments: { workspaceId: ws.id } }),
    );
    expect(history.history.some((h) => h.id === execRes.historyId)).toBe(true);

    // 8. Run the collection via run_collection with CSV iteration data
    const runOut = parseToolJson<{
      runId: string;
      summary: {
        status: string;
        iterations: number;
        totalRequests: number;
        passedTests: number;
        failedTests: number;
      };
    }>(
      await client.callTool({
        name: "run_collection",
        arguments: {
          folderId: col.id,
          environmentId: env.id,
          dataCsv: "greeting\niter-one\niter-two\n",
          selectedRequestIds: [req2.id],
        },
      }),
    );
    expect(runOut.summary.status).toBe("passed");
    expect(runOut.summary.iterations).toBe(2);
    expect(runOut.summary.totalRequests).toBe(2);
    expect(runOut.summary.passedTests).toBe(2);

    // Fetch JUnit XML report for the run
    const junitRes = await client.callTool({
      name: "get_run",
      arguments: { runId: runOut.runId, format: "junit" },
    });
    const junitXml = (junitRes.content as { type: string; text: string }[])[0].text;
    expect(junitXml).toContain("<testsuites");
    expect(junitXml).toContain('testcase name="is 201"');

    // 9. Read MCP resources
    const reqResource = await client.readResource({ uri: `postbox://requests/${req1.id}` });
    const reqResourceData = JSON.parse((reqResource.contents[0] as { text: string }).text);
    expect(reqResourceData.name).toBe("Echo Greeting");

    const envResource = await client.readResource({ uri: `postbox://environments/${env.id}` });
    const envResourceData = JSON.parse((envResource.contents[0] as { text: string }).text);
    expect(envResourceData.variables.find((v: { key: string }) => v.key === "api_key").value).toBe(
      "••••••••",
    );

    // 10. Import OpenAPI spec and export collection
    const imported = parseToolJson<{ kind: string; id: string; name: string; requests: number }>(
      await client.callTool({
        name: "import_spec",
        arguments: {
          workspaceId: ws.id,
          content: JSON.stringify({
            openapi: "3.0.0",
            info: { title: "Imported Pet API", version: "1.0.0" },
            servers: [{ url: server.url }],
            paths: {
              "/pets": {
                get: { summary: "List pets", responses: { "200": { description: "ok" } } },
              },
            },
          }),
        },
      }),
    );
    expect(imported.kind).toBe("collection");
    expect(imported.name).toBe("Imported Pet API");
    expect(imported.requests).toBe(1);

    const exportedEnv = parseToolJson<{ name: string; values: { key: string; value: string }[] }>(
      await client.callTool({
        name: "export_environment",
        arguments: { environmentId: env.id, includeSecrets: false },
      }),
    );
    expect(exportedEnv.values.find((v) => v.key === "api_key")?.value).toBe("");
  });

  it("accepts lightweight JSON-RPC POST requests with simple Accept: application/json header", async () => {
    const req = new Request("http://localhost:3000/api/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });
    const res = await mcpRoute.POST(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result?: { tools?: { name: string }[] } };
    expect(body.result?.tools?.some((t) => t.name === "send_request")).toBe(true);
  });

  it("rejects cross-origin browser requests and non-JSON bodies (CSRF / DNS rebinding)", async () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const call = (headers: Record<string, string>) =>
      mcpRoute.POST(new Request("http://localhost:3000/api/mcp", { method: "POST", headers, body }));

    const foreign = await call({
      "Content-Type": "application/json",
      Accept: "application/json",
      Origin: "https://evil.example",
    });
    expect(foreign.status).toBe(403);

    const textPlain = await call({ "Content-Type": "text/plain", Accept: "application/json" });
    expect(textPlain.status).toBe(415);

    const sameOrigin = await call({
      "Content-Type": "application/json",
      Accept: "application/json",
      Origin: "http://localhost:3000",
      Host: "localhost:3000",
    });
    expect(sameOrigin.status).toBe(200);

    process.env.MCP_ALLOWED_ORIGINS = "https://webui.example";
    try {
      const allowed = await call({
        "Content-Type": "application/json",
        Accept: "application/json",
        Origin: "https://webui.example",
      });
      expect(allowed.status).toBe(200);
    } finally {
      delete process.env.MCP_ALLOWED_ORIGINS;
    }
  });
});
