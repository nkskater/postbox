import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-soapui-api-"));
process.env.DATABASE_PATH = path.join(directory, "test.db");
const source = fs.readFileSync(new URL("./fixtures/soapui/migration.xml", import.meta.url), "utf8");
let repo: typeof import("@/server/repo");
let route: typeof import("@/app/api/import/route");
let mcp: typeof import("@/app/api/mcp/route");
let client: Client;
beforeAll(async () => {
  repo = await import("@/server/repo");
  route = await import("@/app/api/import/route");
  mcp = await import("@/app/api/mcp/route");
  const transport = new StreamableHTTPClientTransport(new URL("http://localhost/api/mcp"), {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      return request.method === "POST"
        ? mcp.POST(request)
        : request.method === "GET"
          ? mcp.GET()
          : mcp.DELETE();
    },
  });
  client = new Client({ name: "soapui-import-test", version: "1.0.0" });
  await client.connect(transport);
});
afterAll(async () => {
  await client?.close();
  const { getSqlite } = await import("@/server/db");
  getSqlite().close();
  fs.rmSync(directory, { recursive: true, force: true });
});
const post = (workspaceId: string, extra: Record<string, unknown> = {}) =>
  route.POST(
    new Request("http://localhost/api/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId, content: source, ...extra }),
    }),
  );
function parseTool(result: Awaited<ReturnType<Client["callTool"]>>) {
  expect(result.isError).not.toBe(true);
  return JSON.parse((result.content as { text: string }[])[0].text);
}

describe("SoapUI shared REST/MCP importer", () => {
  it("previews source counts and diagnostics without persisting folders, requests or secrets", async () => {
    const ws = repo.createWorkspace("Preview");
    const before = repo.getTreeSummary(ws.id);
    const response = await post(ws.id, { preview: true, includeCredentials: true });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({
      kind: "preview",
      source: "soapui",
      name: "Migration Lab",
      requests: 6,
      folders: 9,
      variables: 14,
      includeCredentials: true,
      sourceCounts: {
        requestDefinitions: 4,
        requestTestSteps: 3,
        convertedRequests: 6,
        skippedRequests: 1,
        assertions: 2,
        scripts: 2,
      },
    });
    expect(result.diagnostics.map((d: { code: string }) => d.code)).toContain("unsupported-assertion");
    expect(repo.getTreeSummary(ws.id)).toEqual(before);
    expect(repo.listVariables(ws.id, "global", null)).toEqual([]);
    for (const secret of ["alice", "secret-value", "token-value", "inline-secret", "sensitive-bearer"])
      expect(JSON.stringify(result)).not.toContain(secret);
  });
  it("imports exactly the previewed snapshots and metadata with credentials omitted by default", async () => {
    const ws = repo.createWorkspace("REST import");
    const preview = await (await post(ws.id, { preview: true })).json();
    const response = await post(ws.id);
    expect(response.status).toBe(201);
    const result = await response.json();
    expect(result).toMatchObject({
      kind: "collection",
      source: "soapui",
      requests: preview.requests,
      folders: preview.folders,
      sourceCounts: preview.sourceCounts,
    });
    const tree = repo.getFolderTree(result.id)!;
    expect(repo.getTreeSummary(ws.id).requests).toHaveLength(6);
    const variables = repo.listVariables(ws.id, "collection", result.id);
    expect(variables.find((v) => v.key === "username")).toMatchObject({ type: "secret", value: "" });
    for (const secret of ["alice", "secret-value", "token-value", "inline-secret", "sensitive-bearer"])
      expect(JSON.stringify({ tree, variables })).not.toContain(secret);
  });
  it("imports credential values only with the explicit includeCredentials flag", async () => {
    const ws = repo.createWorkspace("Credentials");
    const result = await (await post(ws.id, { includeCredentials: true })).json();
    const variables = repo.listVariables(ws.id, "collection", result.id);
    expect(variables.find((v) => v.key === "password")).toMatchObject({
      type: "secret",
      value: "secret-value",
    });
    expect(variables.find((v) => v.key === "username")).toMatchObject({ type: "secret", value: "alice" });
    expect(variables.some((v) => v.type === "secret" && v.value === "Bearer sensitive-bearer")).toBe(true);
  });
  it("returns an error with no writes for malformed XML, custom entities or invalid previews", async () => {
    const ws = repo.createWorkspace("Bad XML"),
      baseline = repo.getTreeSummary(ws.id);
    for (const content of [
      "<soapui-project>",
      '<!DOCTYPE soapui-project [<!ENTITY x SYSTEM "http://127.0.0.1:1/not-fetched">]><soapui-project>&x;</soapui-project>',
      JSON.stringify({ info: { name: "JSON preview" }, item: [] }),
    ]) {
      expect((await post(ws.id, { content, preview: true })).status).toBe(400);
      expect(repo.getTreeSummary(ws.id)).toEqual(baseline);
    }
  });
  it("leaves existing Postman JSON imports unchanged even when request text mentions SoapUI", async () => {
    const ws = repo.createWorkspace("Existing formats");
    const content = JSON.stringify({
      info: { name: "Legacy" },
      item: [
        {
          name: "Text",
          request: {
            method: "POST",
            url: "https://api.test",
            body: { mode: "raw", raw: '<soapui-project name="just text"/>' },
          },
        },
      ],
    });
    const response = await post(ws.id, { content });
    expect(response.status).toBe(201);
    const result = await response.json();
    expect(result).toMatchObject({ kind: "collection", source: "postman", requests: 1 });
  });
  it("advertises SoapUI XML and a preview flag through MCP discovery", async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "import_spec")!;
    expect(tool.description).toContain("SoapUI XML");
    expect(tool.inputSchema.properties).toHaveProperty("preview");
  });
  it("previews then imports the same SoapUI project over MCP without executing source scripts", async () => {
    const ws = repo.createWorkspace("MCP import");
    const preview = parseTool(
      await client.callTool({
        name: "import_spec",
        arguments: { workspaceId: ws.id, content: source, preview: true },
      }),
    );
    expect(preview).toMatchObject({ kind: "preview", source: "soapui", requests: 6 });
    expect(repo.getTreeSummary(ws.id).requests).toEqual([]);
    const result = parseTool(
      await client.callTool({
        name: "import_spec",
        arguments: { workspaceId: ws.id, content: source, includeCredentials: true },
      }),
    );
    expect(result).toMatchObject({
      kind: "collection",
      source: "soapui",
      requests: 6,
      sourceCounts: preview.sourceCounts,
    });
    expect(repo.getTreeSummary(ws.id).requests).toHaveLength(6);
    expect(
      repo.listVariables(ws.id, "collection", result.id).find((v) => v.key === "password"),
    ).toMatchObject({ type: "secret", value: "secret-value" });
    expect(JSON.stringify(repo.getFolderTree(result.id))).not.toContain("must not execute");
  });
});
