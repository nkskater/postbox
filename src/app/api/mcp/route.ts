/**
 * /api/mcp — Model Context Protocol (MCP) Streamable HTTP endpoint.
 *
 * Compatible with Claude Code (`claude mcp add --transport http postbox http://localhost:3000/api/mcp`),
 * Open WebUI, Cursor, MCP Inspector, and any Streamable HTTP or JSON-RPC MCP client.
 */
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createPostboxMcpServer } from "@/server/mcp";

export const dynamic = "force-dynamic";

function normalizePostRequest(req: Request): Request {
  const accept = req.headers.get("accept") ?? "";
  const contentType = req.headers.get("content-type") ?? "";
  const needsAcceptFix = !accept.includes("application/json") || !accept.includes("text/event-stream");
  const needsContentTypeFix = !contentType.includes("application/json");

  if (!needsAcceptFix && !needsContentTypeFix) return req;

  const headers = new Headers(req.headers);
  if (needsAcceptFix) {
    headers.set("accept", "application/json, text/event-stream");
  }
  if (needsContentTypeFix) {
    headers.set("content-type", "application/json");
  }
  return new Request(req.url, {
    method: req.method,
    headers,
    body: req.body,
    // @ts-expect-error Node fetch requires duplex: "half" when passing a ReadableStream body
    duplex: "half",
    signal: req.signal,
  });
}

export async function POST(req: Request): Promise<Response> {
  const server = createPostboxMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(normalizePostRequest(req));
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
      "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, Mcp-Session-Id, MCP-Protocol-Version",
    },
  });
}
