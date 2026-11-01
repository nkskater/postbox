/**
 * /api/mcp — Model Context Protocol (MCP) Streamable HTTP endpoint.
 *
 * Compatible with Claude Code (`claude mcp add --transport http postbox http://localhost:3000/api/mcp`),
 * Open WebUI, Cursor, MCP Inspector, and any Streamable HTTP or JSON-RPC MCP client.
 */
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { HttpError, readBodyText } from "@/server/http";
import { callerOf } from "@/server/caller";
import { withCaller } from "@/server/access-context";
import { audit } from "@/server/audit";
import { authorizeTool, isReadOnlyTool, resourceWorkspace } from "@/server/access-policy";
import { mcpSettings } from "@/server/integration-settings";
import { authorize } from "@/server/authorize";
import { createPostboxMcpServer } from "@/server/mcp";

export const dynamic = "force-dynamic";

/**
 * Browsers attach an Origin header to cross-site POSTs. Rejecting foreign origins stops
 * web pages (and DNS-rebinding attacks) from driving MCP tools through the user's browser,
 * as required by the MCP Streamable HTTP spec. Non-browser clients send no Origin.
 * Extra trusted origins (e.g. a browser-based MCP client) are set under Settings → MCP &
 * integrations (or pinned with MCP_ALLOWED_ORIGINS).
 */
export function isAllowedOrigin(req: Request, extraOrigins = mcpSettings().allowedOrigins): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? new URL(req.url).host;
  if (originHost === host) return true;
  return extraOrigins.includes(origin.replace(/\/$/, ""));
}

function jsonRpcError(status: number, message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Some clients only send `Accept: application/json`; the SDK transport insists on both
 * JSON and SSE, so the Accept header is widened. Content-Type is deliberately NOT rewritten:
 * requiring application/json keeps cross-site "simple" form/text POSTs from being accepted.
 */
function normalizeAccept(req: Request, body: string): Request {
  const headers = new Headers(req.headers);
  const accept = headers.get("accept") ?? "";
  if (!(accept.includes("application/json") && accept.includes("text/event-stream")))
    headers.set("accept", "application/json, text/event-stream");
  headers.delete("content-length");
  return new Request(req.url, { method: req.method, headers, body, signal: req.signal });
}

/** Record mutating tool calls that succeeded, with the ids and argument names but never argument values. */
function recordToolCall(body: string, res: Response) {
  void (async () => {
    try {
      const message = JSON.parse(body);
      const name = String(message.params?.name);
      if (message.method !== "tools/call" || isReadOnlyTool(name)) return;
      const reply = (await res.clone().json()) as { result?: { isError?: boolean } };
      if (reply.result?.isError) return;
      const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
      const ids = Object.fromEntries(
        Object.entries(args).filter(([k, v]) => /Id$/.test(k) && typeof v === "string"),
      );
      audit({
        action: `mcp.${name}`,
        entityKind: "other",
        entityId: Object.values(ids)[0] as string | undefined,
        workspaceId: typeof args.workspaceId === "string" ? args.workspaceId : null,
        via: "mcp",
        meta: { tool: name, ids, arguments: Object.keys(args) },
      });
    } catch {
      /* never affects the response */
    }
  })();
}

export async function POST(req: Request): Promise<Response> {
  const settings = mcpSettings();
  if (!settings.enabled) return jsonRpcError(503, "MCP is disabled by an administrator");
  if (!isAllowedOrigin(req, settings.allowedOrigins))
    return jsonRpcError(403, "Forbidden: cross-origin MCP requests are not allowed");
  if (!(req.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) {
    return jsonRpcError(415, "Unsupported Media Type: MCP requests must use Content-Type: application/json");
  }
  let body: string;
  try {
    body = await readBodyText(req);
  } catch (err) {
    if (err instanceof HttpError) return jsonRpcError(err.status, err.message);
    throw err;
  }
  const caller = callerOf(req);
  if (!caller) return jsonRpcError(401, "Authentication required");
  try {
    const message = JSON.parse(body);
    if (Array.isArray(message)) return jsonRpcError(400, "Batch requests are not supported");
    if (message.method === "tools/call") {
      try {
        if (settings.readOnly && !isReadOnlyTool(String(message.params?.name)))
          throw new HttpError(
            403,
            `MCP is read-only: "${message.params?.name}" would change data. An administrator can turn this off under Settings → MCP & integrations.`,
          );
        authorizeTool(caller, message.params?.name, message.params?.arguments ?? {});
      } catch (error) {
        if (!(error instanceof HttpError)) throw error;
        return Response.json({
          jsonrpc: "2.0",
          id: message.id ?? null,
          result: {
            isError: true,
            content: [{ type: "text", text: JSON.stringify({ error: error.message, status: error.status }) }],
          },
        });
      }
    } else if (message.method === "resources/read") {
      const uri = new URL(message.params?.uri);
      if (uri.protocol !== "postbox:") throw new HttpError(403, "Unknown resource");
      const parts = uri.pathname.split("/").filter(Boolean);
      const kinds = {
        workspaces: "workspace",
        folders: "folder",
        requests: "request",
        environments: "environment",
      } as const;
      const kind = kinds[uri.hostname as keyof typeof kinds];
      if (!kind) throw new HttpError(403, "Unknown resource");
      if (parts[0]) authorize(caller, resourceWorkspace(kind, parts[0]), "read");
    }
  } catch (error) {
    if (error instanceof HttpError) return jsonRpcError(error.status, error.message);
    return jsonRpcError(400, "Invalid MCP request");
  }
  return withCaller(caller, async () => {
    const server = createPostboxMcpServer({ readOnly: settings.readOnly });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      const res = await transport.handleRequest(normalizeAccept(req, body));
      recordToolCall(body, res);
      return res;
    } finally {
      await server.close();
    }
  });
}

export async function GET(): Promise<Response> {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Method Not Allowed: Use POST /api/mcp for stateless Streamable HTTP MCP requests.",
      },
      id: null,
    }),
    {
      status: 405,
      headers: {
        Allow: "POST, DELETE, OPTIONS",
        "Content-Type": "application/json",
      },
    },
  );
}

export async function DELETE(): Promise<Response> {
  return new Response(null, { status: 204 });
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, {
    status: 204,
    headers: {
      Allow: "POST, GET, DELETE, OPTIONS",
      "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type, Accept, Authorization, Mcp-Session-Id, MCP-Protocol-Version",
    },
  });
}
