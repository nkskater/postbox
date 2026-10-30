/**
 * /api/mcp — Model Context Protocol (MCP) Streamable HTTP endpoint.
 *
 * Compatible with Claude Code (`claude mcp add --transport http postbox http://localhost:3000/api/mcp`),
 * Open WebUI, Cursor, MCP Inspector, and any Streamable HTTP or JSON-RPC MCP client.
 */
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { HttpError, readBodyText } from "@/server/http";
import { createPostboxMcpServer } from "@/server/mcp";

export const dynamic = "force-dynamic";

/**
 * Browsers attach an Origin header to cross-site POSTs. Rejecting foreign origins stops
 * web pages (and DNS-rebinding attacks) from driving MCP tools through the user's browser,
 * as required by the MCP Streamable HTTP spec. Non-browser clients send no Origin.
 * Extra trusted origins (e.g. a browser-based MCP client) go in MCP_ALLOWED_ORIGINS.
 */
export function isAllowedOrigin(req: Request): boolean {
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
  const allowed = (process.env.MCP_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim().replace(/\/$/, ""))
    .filter(Boolean);
  return allowed.includes(origin.replace(/\/$/, ""));
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

export async function POST(req: Request): Promise<Response> {
  if (!isAllowedOrigin(req)) return jsonRpcError(403, "Forbidden: cross-origin MCP requests are not allowed");
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
  const server = createPostboxMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(normalizeAccept(req, body));
  } finally {
    await server.close();
  }
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
