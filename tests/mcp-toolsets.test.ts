import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

process.env.DATABASE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "postbox-toolsets-")), "test.db");
const route = await import("@/app/api/mcp/route");
const settings = await import("@/server/settings");
const { MCP_POLICIES } = await import("@/server/access-policy");
const { default: Ajv2020 } = await import("ajv/dist/2020.js");
type Tool = { name: string; inputSchema: Record<string, unknown> };
async function rpc(method: string, params: object = {}, query = "") {
  const response = await route.POST(
    new Request(`http://localhost/api/mcp${query}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
  );
  return { status: response.status, text: await response.text() };
}
async function tools(query = "") {
  const result = await rpc("tools/list", {}, query);
  expect(result.status).toBe(200);
  return { ...result, tools: JSON.parse(result.text).result.tools as Tool[] };
}
afterEach(() => {
  vi.unstubAllEnvs();
  settings.patchSettings({ "mcp.toolsets": null, "mcp.readOnly": null });
});

describe("MCP advertised toolsets", () => {
  it("defaults to core within a 40 kB wire budget", async () => {
    const result = await tools();
    console.info(`Default MCP tools: ${result.tools.length}, ${Buffer.byteLength(result.text)} bytes`);
    expect(result.tools.map((tool) => tool.name)).toContain("send_request");
    expect(result.tools.map((tool) => tool.name)).not.toContain("create_mock");
    expect(Buffer.byteLength(result.text)).toBeLessThan(40_000);
  });
  it("advertises every tool with all within 120 kB", async () => {
    const result = await tools("?toolsets=all");
    console.info(`All MCP tools: ${result.tools.length}, ${Buffer.byteLength(result.text)} bytes`);
    expect(result.tools.map((tool) => tool.name).sort()).toEqual(Object.keys(MCP_POLICIES).sort());
    expect(result.tools.map((tool) => tool.name)).toContain("create_mock");
    expect(Buffer.byteLength(result.text)).toBeLessThan(120_000);
  });
  it("selects one domain without implicitly adding core", async () => {
    const result = await tools("?toolsets=mocks");
    expect(result.tools.map((tool) => tool.name)).toContain("create_mock");
    expect(result.tools.map((tool) => tool.name)).not.toContain("send_request");
  });
  it("reuses registration across lists and calls", async () => {
    await tools("?toolsets=all");
    const spy = vi.spyOn(McpServer.prototype, "registerTool");
    try {
      await Promise.all([tools(), tools("?toolsets=mocks"), rpc("tools/call", { name: "whoami" })]);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
  it("compiles every advertised schema as JSON Schema 2020-12 with local refs", async () => {
    const result = await tools("?toolsets=all");
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    for (const tool of result.tools) expect(() => ajv.compile(tool.inputSchema), tool.name).not.toThrow();
  });
  it("applies saved defaults, query overrides and environment pins immediately", async () => {
    settings.patchSettings({ "mcp.toolsets": "mocks" });
    expect((await tools()).tools.map((tool) => tool.name)).toContain("create_mock");
    expect((await tools()).tools.map((tool) => tool.name)).not.toContain("send_request");
    expect((await tools("?toolsets=core")).tools.map((tool) => tool.name)).toContain("send_request");
    vi.stubEnv("MCP_TOOLSETS", "datasets");
    expect((await tools()).tools.map((tool) => tool.name)).toContain("create_dataset");
    expect((await tools()).tools.map((tool) => tool.name)).not.toContain("create_mock");
  });
  it("refuses malformed query selections instead of exposing all tools", async () => {
    for (const query of [
      "?toolsets=",
      "?toolsets=unknown",
      "?toolsets=all,core",
      "?toolsets=core&toolsets=mocks",
    ]) {
      expect((await rpc("tools/list", {}, query)).status).toBe(400);
    }
  });
  it("allows known hidden tools with original server-side argument validation", async () => {
    expect((await tools()).tools.map((tool) => tool.name)).not.toContain("create_mock");
    const workspace = await rpc("tools/call", {
      name: "create_workspace",
      arguments: { name: "Hidden tool" },
    });
    const workspaceId = JSON.parse(JSON.parse(workspace.text).result.content[0].text).id;
    const result = await rpc("tools/call", {
      name: "list_mocks",
      arguments: { workspaceId },
    });
    expect(JSON.parse(result.text).result.isError).not.toBe(true);
    const invalid = await rpc("tools/call", {
      name: "send_request",
      arguments: {
        workspaceId,
        url: "https://example.test",
        auth: { type: "bearer", bearer: { token: 99 } },
      },
    });
    expect(JSON.parse(invalid.text).result.isError).toBe(true);
    expect(JSON.parse(invalid.text).result.content[0].text).toMatch(
      /Input validation error|Invalid arguments/,
    );
  });
  it("keeps read-only enforcement active across cached selections and setting changes", async () => {
    await tools("?toolsets=all");
    settings.patchSettings({ "mcp.readOnly": true });
    expect((await tools("?toolsets=all")).tools.map((tool) => tool.name)).not.toContain("create_mock");
    const denied = await rpc(
      "tools/call",
      { name: "create_workspace", arguments: { name: "Denied" } },
      "?toolsets=mocks",
    );
    expect(JSON.parse(denied.text).result.isError).toBe(true);
    settings.patchSettings({ "mcp.readOnly": false });
    expect((await tools()).tools.map((tool) => tool.name)).toContain("create_workspace");
  });
});
