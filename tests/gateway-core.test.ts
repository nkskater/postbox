import http from "node:http";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gatewayRouteInput, applyGatewayPolicy, upstreamPath } from "@/core/gateway/model";
import { validateMcpMetadata } from "@/core/gateway/mcp";
import { GatewayRedactor } from "@/core/gateway/redactor";
import { openGatewayStream, type GatewayCompletion } from "@/core/gateway/transport";
import { HostPolicy } from "@/core/http/policy";
const config = (kind: "api" | "llm" | "mcp", policy = {}) =>
  gatewayRouteInput.parse({ name: "Test", apiId: "provider", kind, enabled: true, policy });

describe("gateway policy", () => {
  it("enforces methods, paths, model and output budget before forwarding", () => {
    const route = config("llm", { allowedModels: ["local"], maxOutputTokens: 20, pathPrefixes: ["/chat"] });
    const apply = (value: unknown, path = "/chat/completions", method = "POST") =>
      applyGatewayPolicy(route, method, path, Buffer.from(JSON.stringify(value)));
    expect(JSON.parse(apply({ model: "local" }).toString())).toEqual({ model: "local", max_tokens: 20 });
    expect(() => apply({ model: "other" })).toThrow("Model is not allowed");
    expect(() => apply({ model: "local", max_completion_tokens: 21 })).toThrow("budget");
    expect(() => apply({ model: "local" }, "/admin")).toThrow("Path");
    expect(() => apply({ model: "local" }, "/chat", "DELETE")).toThrow("Method");
    expect(() => applyGatewayPolicy(route, "POST", "/chat", Buffer.alloc(0))).toThrow("JSON body");
    expect(() => upstreamPath("/v1", "/%252e%252e/private")).toThrow();
    expect(upstreamPath("/mcp", "/")).toBe("/mcp");
  });
  it("checks every message in MCP batches and restricts tools", () => {
    const route = config("mcp", { allowedMcpTools: ["read"] });
    const apply = (value: unknown) =>
      applyGatewayPolicy(route, "POST", "/", Buffer.from(JSON.stringify(value)));
    const read = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read" } };
    expect(apply(read).length).toBeGreaterThan(0);
    expect(() => apply([read, { ...read, params: { name: "delete" } }])).toThrow("tool");
    expect(() => apply({ jsonrpc: "2.0", method: "admin/reset" })).toThrow("method");
  });
});

it("redacts credential variants at every possible stream chunk boundary", () => {
  const secret = "private-key-123";
  const text = Buffer.from(`before:${secret}:after:${Buffer.from(secret).toString("base64")}:done`);
  for (let at = 0; at <= text.length; at++) {
    const redactor = new GatewayRedactor([secret]);
    const result = Buffer.concat([
      redactor.feed(text.subarray(0, at)),
      redactor.feed(text.subarray(at)),
      redactor.feed(Buffer.alloc(0), true),
    ]).toString();
    expect(result).toBe("before:[redacted]:after:[redacted]:done");
  }
});

let server: http.Server,
  base: string,
  calls = 0,
  disconnected = false;
beforeAll(async () => {
  server = http.createServer((req, res) => {
    calls++;
    if (req.url === "/http-error") {
      res.writeHead(503);
      res.end("temporarily unavailable");
      return;
    }
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "/ok" });
      res.end();
      return;
    }
    if (req.url === "/slow") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const timer = setInterval(() => res.write("data: tick\n\n"), 10);
      res.on("close", () => {
        disconnected = true;
        clearInterval(timer);
      });
      return;
    }
    if (req.url === "/gzip") {
      res.setHeader("content-encoding", "gzip");
      res.end(gzipSync("provider-secret"));
      return;
    }
    res.setHeader("content-type", "text/plain");
    res.write("hello provider-");
    setTimeout(() => res.end("secret world"), 5);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});
const open = (
  path: string,
  options: Partial<Parameters<typeof openGatewayStream>[0]> = {},
  results: GatewayCompletion[] = [],
) =>
  openGatewayStream({
    url: base + path,
    method: "GET",
    headers: [],
    body: Buffer.alloc(0),
    policy: new HostPolicy(),
    secrets: ["provider-secret"],
    timeoutMs: 2000,
    maxResponseBytes: 10000,
    allowStreaming: true,
    onComplete: (r) => results.push(r),
    ...options,
  });

describe("gateway transport", () => {
  it("streams and redacts text and compressed responses", async () => {
    const results: GatewayCompletion[] = [];
    const response = await open("/ok", {}, results);
    expect(await new Response(response.body).text()).toBe("hello [redacted] world");
    expect(results).toMatchObject([{ outcome: "success", code: "ok" }]);
    expect(await new Response((await open("/gzip")).body).text()).toBe("[redacted]");
  });
  it("records upstream HTTP failures as errors", async () => {
    const results: GatewayCompletion[] = [];
    const response = await open("/http-error", {}, results);
    expect(response.status).toBe(503);
    await new Response(response.body).text();
    expect(results).toMatchObject([{ status: 503, outcome: "error", code: "upstream_status" }]);
  });
  it("rejects redirects and forbidden outbound hosts without a second request", async () => {
    const before = calls;
    await expect(open("/redirect")).rejects.toThrow("redirects");
    expect(calls).toBe(before + 1);
    await expect(open("/ok", { policy: new HostPolicy([], ["127.0.0.1"]) })).rejects.toThrow("outbound");
    expect(calls).toBe(before + 1);
  });
  it("propagates client cancellation and enforces response size limits", async () => {
    const response = await open("/slow");
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    await new Promise((r) => setTimeout(r, 30));
    expect(disconnected).toBe(true);
    const limited = await open("/ok", { maxResponseBytes: 5 });
    await expect(new Response(limited.body).text()).rejects.toThrow();
  });
  it("enforces a total deadline and can disable SSE", async () => {
    const response = await open("/slow", { timeoutMs: 50 });
    await expect(new Response(response.body).text()).rejects.toThrow();
    await expect(open("/slow", { allowStreaming: false })).rejects.toThrow("disabled");
  });
});

it("validates modern MCP metadata, encoded names and legacy message compatibility", () => {
  const message = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "read", _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } },
  };
  const body = Buffer.from(JSON.stringify(message));
  const headers = new Headers({
    "mcp-protocol-version": "2026-07-28",
    "mcp-method": "tools/call",
    "mcp-name": "read",
  });
  expect(() => validateMcpMetadata(headers, body)).not.toThrow();
  headers.set("mcp-name", "delete");
  expect(() => validateMcpMetadata(headers, body)).toThrow("metadata");
  headers.set("mcp-name", "=?base64?cmVhZA==?=");
  expect(() => validateMcpMetadata(headers, body)).not.toThrow();
  headers.delete("mcp-method");
  expect(() => validateMcpMetadata(headers, body)).toThrow("metadata");
  expect(() =>
    validateMcpMetadata(
      new Headers({ "mcp-protocol-version": "2025-11-25" }),
      Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" })),
    ),
  ).not.toThrow();
});
