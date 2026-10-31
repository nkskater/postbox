import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import zlib from "node:zlib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { HostPolicy } from "@/core/http/policy";
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-openapi-"));
process.env.DATABASE_PATH = path.join(directory, "test.db");
const paths = ["openapi.yaml", "paths/pets.yaml", "models/pet.yaml", "shared/common.json"];
const files = paths.map((path) => ({
  path: `project/${path}`,
  content: fs.readFileSync(new URL(`./fixtures/openapi/${path}`, import.meta.url), "utf8"),
}));
let repo: typeof import("@/server/repo");
let route: typeof import("@/app/api/import/route");
let importSource: typeof import("@/server/import-source").importSource;
let client: Client;
const servers: http.Server[] = [];
const seen: { url: string; headers: http.IncomingHttpHeaders }[] = [];
let origin: string, destination: string;
const root = (ref: string) =>
  JSON.stringify({
    openapi: "3.1.0",
    info: { title: "Remote refs" },
    paths: {
      "/pets": {
        post: {
          requestBody: { content: { "application/json": { schema: { $ref: ref } } } },
          responses: { 200: { description: "OK" } },
        },
      },
    },
  });
async function listen(handler: http.RequestListener) {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
beforeAll(async () => {
  repo = await import("@/server/repo");
  route = await import("@/app/api/import/route");
  ({ importSource } = await import("@/server/import-source"));
  const mcp = await import("@/app/api/mcp/route");
  client = new Client({ name: "openapi-reference-test", version: "1.0.0" });
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
  destination = await listen((req, res) => {
    seen.push({ url: `destination${req.url}`, headers: req.headers });
    res.setHeader("Content-Type", "application/json");
    res.end('{"Pet":{"type":"string","default":"redirected"}}');
  });
  origin = await listen((req, res) => {
    seen.push({ url: req.url!, headers: req.headers });
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/start") {
      res.writeHead(302, { Location: "/v2/openapi.json" });
      return res.end();
    }
    if (req.url === "/v2/openapi.json") return res.end(root("models.json#/Pet"));
    if (req.url === "/redirect.json") {
      res.writeHead(302, { Location: `${destination}/model.json` });
      return res.end();
    }
    if (req.url?.startsWith("/chain/")) {
      const i = Number(req.url.split("/").at(-1));
      return res.end(JSON.stringify({ Pet: { $ref: `/chain/${i + 1}#/Pet` } }));
    }
    if (req.url === "/large.json") return res.end('"' + "x".repeat(5 * 1024 * 1024) + '"');
    if (req.url === "/compressed.json") {
      res.setHeader("Content-Encoding", "gzip");
      return res.end(zlib.gzipSync(Buffer.from('"' + "x".repeat(5 * 1024 * 1024) + '"')));
    }
    if (req.url === "/loop") {
      res.writeHead(302, { Location: "/loop" });
      return res.end();
    }
    if (req.url === "/missing.json") {
      res.writeHead(404);
      return res.end("{}");
    }
    if (req.url === "/v2/models.json")
      return res.end('{"Pet":{"type":"object","properties":{"name":{"type":"string","default":"remote"}}}}');
    return res.end('{"Pet":{"type":"integer","default":42}}');
  });
});
afterAll(async () => {
  await client?.close();
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  const { getSqlite } = await import("@/server/db");
  getSqlite().close();
  fs.rmSync(directory, { recursive: true, force: true });
});
const post = (workspaceId: string, input: Record<string, unknown>) =>
  route.POST(
    new Request("http://localhost/api/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId, ...input }),
    }),
  );
const toolJson = (result: Awaited<ReturnType<Client["callTool"]>>) =>
  JSON.parse((result.content as { text: string }[])[0].text);

describe("OpenAPI shared REST/MCP importer", () => {
  it("previews a folder without writes, then persists the complete resolved request tree", async () => {
    const ws = repo.createWorkspace("Folder import"),
      baseline = repo.getTreeSummary(ws.id);
    const input = {
      files,
      entrypoint: "project/openapi.yaml",
      sourceUrl: "https://api.example/spec/openapi.yaml",
    };
    const preview = await post(ws.id, { ...input, preview: true });
    expect(preview.status).toBe(200);
    const metadata = await preview.json();
    expect(metadata).toMatchObject({
      kind: "preview",
      source: "openapi",
      requests: 2,
      references: { documents: 4, remoteFetches: 0 },
    });
    expect(metadata.diagnostics.some((d: { code: string }) => d.code === "cyclic-reference")).toBe(true);
    expect(repo.getTreeSummary(ws.id)).toEqual(baseline);
    const response = await post(ws.id, input);
    expect(response.status).toBe(201);
    const imported = await response.json();
    expect(imported).toMatchObject({ source: "openapi", requests: 2, references: metadata.references });
    expect(repo.getTreeSummary(ws.id).requests).toHaveLength(2);
    expect(repo.listVariables(ws.id, "collection", imported.id).find((v) => v.key === "id")?.value).toBe("7");
    const tree = repo.getFolderTree(imported.id)!;
    expect(JSON.stringify(tree)).toContain("Mochi");
    expect(JSON.stringify(tree)).not.toContain("../models/pet.yaml");
  });
  it("exposes the same bundle preview, import, structured errors and arguments over MCP", async () => {
    const ws = repo.createWorkspace("MCP folder"),
      baseline = repo.getTreeSummary(ws.id);
    const args = { workspaceId: ws.id, files, entrypoint: "project/openapi.yaml" };
    const preview = await client.callTool({ name: "import_spec", arguments: { ...args, preview: true } });
    expect(preview.isError).not.toBe(true);
    expect(toolJson(preview)).toMatchObject({ kind: "preview", source: "openapi", requests: 2 });
    expect(repo.getTreeSummary(ws.id)).toEqual(baseline);
    const imported = await client.callTool({ name: "import_spec", arguments: args });
    expect(imported.isError).not.toBe(true);
    expect(toolJson(imported)).toMatchObject({ kind: "collection", requests: 2 });
    const error = await client.callTool({
      name: "import_spec",
      arguments: { workspaceId: ws.id, content: root("missing.yaml#/Pet") },
    });
    expect(error.isError).toBe(true);
    expect(toolJson(error).diagnostics[0].code).toBe("missing-file");
    const schema = (await client.listTools()).tools.find((t) => t.name === "import_spec")!.inputSchema;
    expect(Object.keys(schema.properties!)).toEqual(
      expect.arrayContaining(["files", "entrypoint", "sourceUrl", "allowedRefOrigins", "preview"]),
    );
  });
  it("fails missing references and reference-only cycles atomically even after a valid operation", async () => {
    const ws = repo.createWorkspace("Missing"),
      baseline = repo.getTreeSummary(ws.id);
    for (const content of [
      root("#/absent"),
      JSON.stringify({
        ...JSON.parse(root("#/components/schemas/A")),
        components: {
          schemas: { A: { $ref: "#/components/schemas/B" }, B: { $ref: "#/components/schemas/A" } },
        },
      }),
    ]) {
      const response = await post(ws.id, { content });
      expect(response.status).toBe(400);
      expect(
        (await response.json()).diagnostics.some((d: { severity: string }) => d.severity === "error"),
      ).toBe(true);
      expect(repo.getTreeSummary(ws.id)).toEqual(baseline);
    }
  });
  it("uses the fetched root's final URL and approves same-origin external refs explicitly", async () => {
    const ws = repo.createWorkspace("Remote root");
    seen.length = 0;
    const denied = await post(ws.id, { url: `${origin}/start`, preview: true });
    expect(denied.status).toBe(400);
    expect((await denied.json()).diagnostics[0]).toMatchObject({ code: "origin-not-approved", origin });
    expect(seen.map((r) => r.url)).toEqual(["/start", "/v2/openapi.json"]);
    const approved = await post(ws.id, {
      url: `${origin}/start`,
      allowedRefOrigins: [origin],
      preview: true,
    });
    expect(approved.status).toBe(200);
    expect((await approved.json()).references).toMatchObject({ documents: 2, remoteFetches: 1 });
    expect(seen.at(-1)?.url).toBe("/v2/models.json");
    for (const request of seen) {
      expect(request.headers.authorization).toBeUndefined();
      expect(request.headers.cookie).toBeUndefined();
    }
  });
  it("approves every reference redirect destination before connecting, and host policy always wins", async () => {
    const ws = repo.createWorkspace("Redirects");
    seen.length = 0;
    const input = {
      content: root(`${origin}/redirect.json#/Pet`),
      allowedRefOrigins: [origin],
      preview: true,
    };
    const denied = await post(ws.id, input);
    expect(denied.status).toBe(400);
    expect((await denied.json()).diagnostics[0]).toMatchObject({
      code: "origin-not-approved",
      origin: destination,
    });
    expect(seen.some((r) => r.url.startsWith("destination"))).toBe(false);
    const allowed = await post(ws.id, { ...input, allowedRefOrigins: [origin, destination] });
    expect(allowed.status).toBe(200);
    expect(seen.some((r) => r.url === "destination/model.json")).toBe(true);
    seen.length = 0;
    await expect(
      importSource(
        ws.id,
        { ...input, allowedRefOrigins: [origin, destination] },
        { policy: new HostPolicy([], ["127.0.0.1"]) },
      ),
    ).rejects.toMatchObject({ diagnostics: [{ code: "document-fetch" }] });
    expect(seen).toHaveLength(0);
  });
  it("bounds request count, redirects and encoded/decompressed document size with no writes", async () => {
    const ws = repo.createWorkspace("Limits"),
      baseline = repo.getTreeSummary(ws.id);
    for (const [file, code] of [
      ["large.json", "document-size"],
      ["compressed.json", "document-fetch"],
      ["missing.json", "document-status"],
      ["chain/0", "fetch-limit"],
      ["loop", "redirect-limit"],
    ]) {
      const response = await post(ws.id, {
        content: root(`${origin}/${file}#/Pet`),
        allowedRefOrigins: [origin],
      });
      expect(response.status).toBe(400);
      const result = await response.json();
      expect(result.diagnostics.map((d: { code: string }) => d.code)).toContain(code);
      expect(repo.getTreeSummary(ws.id)).toEqual(baseline);
    }
  });
  it("validates contradictory source fields and keeps diagnostic URLs free of query secrets", async () => {
    const ws = repo.createWorkspace("Invalid input");
    for (const input of [
      { files, content: "x", entrypoint: "project/openapi.yaml" },
      { files },
      { content: root("file:///etc/passwd") },
      { url: "file:///etc/passwd" },
      { content: root("https://schema.example/models.json?token=hidden#/Pet") },
    ]) {
      const response = await post(ws.id, input);
      expect(response.status).toBe(400);
      expect(JSON.stringify(await response.json())).not.toContain("token=hidden");
    }
  });
});
