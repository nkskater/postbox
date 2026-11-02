import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectExternalMcp } from "@/core/mcp-client/client";
import { HostPolicy } from "@/core/http/policy";
import { mcpFetch } from "@/core/mcp-client/fetch";
import { startMcpFixture } from "./helpers/mcp-server";
let server: Awaited<ReturnType<typeof startMcpFixture>>;
beforeAll(async () => {
  server = await startMcpFixture();
});
afterAll(async () => {
  await server.close();
});
const config = (path = "/mcp", timeoutMs = 1500) => ({
  url: server.url + path,
  headers: [{ key: "Authorization", value: "Bearer fixture-token" }],
  timeoutMs,
});
describe("external Streamable HTTP MCP client", () => {
  it("negotiates capabilities, paginates tools, reads resources/templates and gets prompts, then terminates the remote session", async () => {
    const client = await connectExternalMcp(config(), new HostPolicy());
    try {
      expect(client.info.server?.name).toBe("Fixture MCP");
      expect(client.info.capabilities).toHaveProperty("tools");
      expect(client.info.protocolVersion).toBe("2025-03-26");
      expect(await client.run({ type: "tools/list" })).toMatchObject({
        nextCursor: "page-2",
        tools: [{ name: "echo" }],
      });
      expect(await client.run({ type: "tools/list", cursor: "page-2" })).toMatchObject({
        tools: [{ name: "second" }],
      });
      expect(
        await client.run({ type: "tools/call", name: "echo", arguments: { value: "hello" } }),
      ).toMatchObject({ content: [{ text: '{"value":"hello"}' }] });
      expect(await client.run({ type: "resources/list" })).toMatchObject({
        resources: [{ uri: "fixture://hello" }],
      });
      expect(await client.run({ type: "resources/templates/list" })).toMatchObject({
        resourceTemplates: [{ uriTemplate: "fixture://{name}" }],
      });
      expect(await client.run({ type: "resources/read", uri: "fixture://hello" })).toMatchObject({
        contents: [{ text: "Hello resource" }],
      });
      expect(await client.run({ type: "prompts/list" })).toMatchObject({ prompts: [{ name: "greet" }] });
      expect(
        await client.run({ type: "prompts/get", name: "greet", arguments: { name: "Ada" } }),
      ).toMatchObject({ messages: [{ content: { text: "Hello Ada" } }] });
      expect(server.sessions.size).toBe(1);
    } finally {
      await client.close();
    }
    expect(server.sessions.size).toBe(0);
    expect(
      server.requests
        .filter((r) => r.method === "POST")
        .every((r) => r.authorization === "Bearer fixture-token"),
    ).toBe(true);
    await client.close();
    await expect(client.run({ type: "tools/list" })).rejects.toMatchObject({ code: "transport" });
  });
  it("supports SSE POST responses and keeps remote tool errors distinct from transport errors", async () => {
    const client = await connectExternalMcp(config("/sse"), new HostPolicy());
    try {
      expect(await client.run({ type: "tools/call", name: "error", arguments: {} })).toMatchObject({
        isError: true,
      });
    } finally {
      await client.close();
    }
  });
  it("returns safe auth/timeout/transport diagnostics and closes failed connections", async () => {
    await expect(connectExternalMcp(config("/auth"), new HostPolicy())).rejects.toMatchObject({
      code: "auth",
    });
    await expect(connectExternalMcp(config("/redirect"), new HostPolicy())).rejects.toMatchObject({
      code: "policy",
    });
    const client = await connectExternalMcp(config("/mcp", 100), new HostPolicy());
    try {
      await expect(client.run({ type: "tools/call", name: "slow", arguments: {} })).rejects.toMatchObject({
        code: "timeout",
      });
    } finally {
      await client.close();
    }
    expect(server.sessions.size).toBe(0);
  });
  it("enforces literal and resolved-address host policy before endpoint traffic, and refuses cross-origin fetches", async () => {
    const before = server.requests.length;
    await expect(connectExternalMcp(config(), new HostPolicy([], ["127.0.0.0/8"]))).rejects.toMatchObject({
      code: "policy",
    });
    await expect(
      connectExternalMcp(
        { ...config(), url: server.url.replace("127.0.0.1", "localhost") + "/mcp" },
        new HostPolicy([], ["127.0.0.0/8", "::1"]),
      ),
    ).rejects.toMatchObject({ code: "policy" });
    expect(server.requests.length).toBe(before);
    const fetch = mcpFetch(server.url, new HostPolicy(), 1000, new AbortController().signal);
    await expect(fetch("https://elsewhere.test/mcp")).rejects.toThrow("origin");
  });
});
