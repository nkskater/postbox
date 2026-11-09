import { z } from "zod";
import { METHODS, buildTarget, parseBaseUrl, pathAllowed } from "../broker/target";

export const gatewayPolicy = z
  .object({
    methods: z.array(z.enum(METHODS)).min(1).default(["GET", "POST"]),
    pathPrefixes: z.array(z.string().min(1).max(200)).max(30).default(["/"]),
    forwardHeaders: z
      .array(z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/))
      .max(30)
      .default([
        "content-type",
        "accept",
        "mcp-protocol-version",
        "mcp-method",
        "mcp-name",
        "mcp-param-*",
        "mcp-session-id",
        "last-event-id",
      ]),
    allowedModels: z.array(z.string().min(1).max(200)).max(100).default([]),
    maxOutputTokens: z.number().int().min(1).max(1000000).default(4096),
    allowedMcpMethods: z
      .array(z.string().min(1).max(100))
      .max(100)
      .default([
        "initialize",
        "notifications/initialized",
        "notifications/cancelled",
        "ping",
        "tools/list",
        "tools/call",
        "resources/list",
        "resources/read",
        "prompts/list",
        "prompts/get",
      ]),
    allowedMcpTools: z.array(z.string().min(1).max(200)).max(100).default([]),
    allowStreaming: z.boolean().default(true),
    requestsPerMinute: z.number().int().min(1).max(100000).default(60),
    requestsPerDay: z.number().int().min(1).max(10000000).default(10000),
    timeoutMs: z.number().int().min(100).max(300000).default(60000),
    maxRequestBytes: z.number().int().min(1).max(10485760).default(1048576),
    maxResponseBytes: z.number().int().min(1).max(52428800).default(5242880),
  })
  .strict();
export type GatewayPolicy = z.infer<typeof gatewayPolicy>;
export const gatewayRouteInput = z
  .object({
    name: z.string().trim().min(1).max(100),
    apiId: z.string().min(1).max(200),
    kind: z.enum(["api", "llm", "mcp"]),
    upstreamPrefix: z.string().max(500).default(""),
    enabled: z.boolean().default(false),
    policy: gatewayPolicy.default(() => gatewayPolicy.parse({})),
  })
  .strict();
export type GatewayRouteConfig = z.infer<typeof gatewayRouteInput>;

export class GatewayPolicyError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 403,
  ) {
    super(message);
  }
}

export function upstreamPath(prefix: string, path: string): string {
  if (prefix.includes("?") || prefix.includes("#"))
    throw new GatewayPolicyError("path", "Upstream prefix must be a path", 400);
  const joined = prefix.replace(/\/+$/, "") + (path === "/" && prefix ? "" : path);
  // Use the same canonical path checks as the credential broker.
  buildTarget(parseBaseUrl("https://gateway.invalid"), joined || "/");
  return joined || "/";
}

/** Validate policy before credentials are loaded or any upstream connection is made. */
export function applyGatewayPolicy(
  config: GatewayRouteConfig,
  method: string,
  path: string,
  body: Buffer,
): Buffer {
  const p = config.policy;
  if (!config.enabled) throw new GatewayPolicyError("disabled", "Gateway route is disabled");
  if (!p.methods.includes(method as (typeof METHODS)[number]))
    throw new GatewayPolicyError("method", "Method is not allowed by this gateway route");
  if (!pathAllowed(p.pathPrefixes, path.split("?")[0]))
    throw new GatewayPolicyError("path", "Path is not allowed by this gateway route");
  if (body.length > p.maxRequestBytes)
    throw new GatewayPolicyError("request_size", "Gateway request is too large", 413);
  upstreamPath(config.upstreamPrefix, path);
  if (config.kind === "api") return body;
  if (!body.length) {
    if (method === "POST")
      throw new GatewayPolicyError("json", "This gateway route requires a JSON body", 400);
    return body;
  }
  let value: unknown;
  try {
    value = JSON.parse(body.toString("utf8"));
  } catch {
    throw new GatewayPolicyError("json", "This gateway route requires JSON", 400);
  }
  if (config.kind === "mcp") {
    const messages = Array.isArray(value) ? value : [value];
    if (!messages.length || messages.length > 100)
      throw new GatewayPolicyError("mcp", "Invalid MCP message batch", 400);
    for (const message of messages) {
      if (!message || typeof message !== "object" || message.jsonrpc !== "2.0")
        throw new GatewayPolicyError("mcp", "MCP messages must use JSON-RPC 2.0", 400);
      if (
        message.method === undefined &&
        Object.hasOwn(message, "id") &&
        (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))
      )
        continue;
      if (typeof message.method !== "string")
        throw new GatewayPolicyError("mcp", "MCP requests must name a method", 400);
      if (!p.allowedMcpMethods.includes(message.method))
        throw new GatewayPolicyError("mcp_method", "MCP method is not allowed");
      if (
        message.method === "tools/call" &&
        p.allowedMcpTools.length &&
        !p.allowedMcpTools.includes(message.params?.name)
      )
        throw new GatewayPolicyError("mcp_tool", "MCP tool is not allowed");
    }
    return body;
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new GatewayPolicyError("json", "LLM requests must be JSON objects", 400);
  const input = value as Record<string, unknown>;
  if (p.allowedModels.length && (typeof input.model !== "string" || !p.allowedModels.includes(input.model)))
    throw new GatewayPolicyError("model", "Model is not allowed");
  if (input.stream && !p.allowStreaming)
    throw new GatewayPolicyError("streaming", "Streaming is disabled for this route");
  const tokenFields = ["max_tokens", "max_completion_tokens", "max_output_tokens"];
  let supplied = false;
  for (const key of tokenFields)
    if (input[key] !== undefined) {
      supplied = true;
      if (
        typeof input[key] !== "number" ||
        !Number.isInteger(input[key]) ||
        input[key] <= 0 ||
        input[key] > p.maxOutputTokens
      )
        throw new GatewayPolicyError("tokens", "Requested output token budget exceeds route policy");
    }
  if (!supplied && !/\/(?:embeddings|models)(?:\?|$)/.test(path))
    input[path.split("?")[0].endsWith("/responses") ? "max_output_tokens" : "max_tokens"] = p.maxOutputTokens;
  const result = Buffer.from(JSON.stringify(input));
  if (result.length > p.maxRequestBytes)
    throw new GatewayPolicyError("request_size", "Gateway request is too large", 413);
  return result;
}
