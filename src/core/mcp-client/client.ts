import { ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mcpFetch } from "./fetch";
import { mcpConnectionSchema, mcpActionSchema, type McpAction, type McpConnectionConfig } from "./model";
import type { HostPolicy } from "../http/policy";
export class McpClientError extends Error {
  constructor(
    readonly code: "auth" | "policy" | "transport" | "protocol" | "timeout" | "limit",
    message: string,
  ) {
    super(message);
    this.name = "McpClientError";
  }
}
export async function connectExternalMcp(raw: McpConnectionConfig, policy: HostPolicy) {
  const config = mcpConnectionSchema.parse(raw),
    url = new URL(config.url);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash)
    throw new McpClientError(
      "transport",
      "Use an HTTP(S) MCP endpoint without embedded credentials or fragment",
    );
  const controller = new AbortController();
  const transport = new StreamableHTTPClientTransport(url, {
    fetch: mcpFetch(url.origin, policy, config.timeoutMs, controller.signal),
    requestInit: { headers: Object.fromEntries(config.headers.map((h) => [h.key, h.value])) },
    reconnectionOptions: {
      maxRetries: 0,
      initialReconnectionDelay: 1000,
      maxReconnectionDelay: 1000,
      reconnectionDelayGrowFactor: 1,
    },
  });
  const client = new Client({ name: "postbox-client", version: "1.0.0" }, { capabilities: {} });
  client.onerror = () => undefined;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      await Promise.race([
        transport.terminateSession(),
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 1000);
          timer.unref?.();
        }),
      ]);
    } catch {
    } finally {
      controller.abort();
      await client.close();
    }
  };
  const failure = (error: unknown) => {
    const e = error as { code?: unknown; message?: string };
    const message = e.message ?? "";
    if (e.code === 401 || e.code === 403 || /401|403|Unauthorized/i.test(message))
      return new McpClientError("auth", "MCP authentication failed; check the configured credentials");
    if (/policy|PROXY_ALLOW|PROXY_DENY|blocked by|not in /i.test(message))
      return new McpClientError("policy", "MCP endpoint was blocked by the outbound host policy");
    if (/timeout|timed out/i.test(message)) return new McpClientError("timeout", "MCP request timed out");
    if (/exceeds|too large/i.test(message))
      return new McpClientError("limit", "MCP message exceeded the size limit");
    if (typeof e.code === "number" && e.code < 0)
      return new McpClientError("protocol", "MCP server rejected this operation");
    return new McpClientError(
      "transport",
      "MCP transport failed; check endpoint connectivity and Streamable HTTP support",
    );
  };
  try {
    await client.connect(transport, { timeout: config.timeoutMs });
  } catch (error) {
    await close();
    throw failure(error);
  }
  const capabilities = client.getServerCapabilities() ?? {};
  const info = {
    server: client.getServerVersion(),
    capabilities,
    instructions: client.getInstructions(),
    protocolVersion: transport.protocolVersion,
  };
  if (Buffer.byteLength(JSON.stringify(info)) > 1048576) {
    await close();
    throw new McpClientError("limit", "MCP server metadata exceeds 1 MiB");
  }
  const run = async (rawAction: McpAction) => {
    if (closed) throw new McpClientError("transport", "MCP session is closed");
    const action = mcpActionSchema.parse(rawAction);
    const options = { timeout: config.timeoutMs };
    try {
      let result: unknown;
      switch (action.type) {
        case "tools/list":
          result = await client.request(
            { method: "tools/list", params: { cursor: action.cursor } },
            ListToolsResultSchema,
            options,
          );
          break;
        case "tools/call":
          result = await client.callTool(
            { name: action.name, arguments: action.arguments },
            undefined,
            options,
          );
          break;
        case "resources/list":
          result = await client.listResources({ cursor: action.cursor }, options);
          break;
        case "resources/templates/list":
          result = await client.listResourceTemplates({ cursor: action.cursor }, options);
          break;
        case "resources/read":
          result = await client.readResource({ uri: action.uri }, options);
          break;
        case "prompts/list":
          result = await client.listPrompts({ cursor: action.cursor }, options);
          break;
        case "prompts/get":
          result = await client.getPrompt({ name: action.name, arguments: action.arguments }, options);
          break;
      }
      if (Buffer.byteLength(JSON.stringify(result)) > 1048576)
        throw new McpClientError("limit", "MCP result exceeds 1 MiB");
      return result;
    } catch (error) {
      if (error instanceof McpClientError) throw error;
      throw failure(error);
    }
  };
  return { info, run, close };
}
export type ExternalMcpClient = Awaited<ReturnType<typeof connectExternalMcp>>;
