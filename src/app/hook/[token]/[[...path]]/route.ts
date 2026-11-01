import { HttpError } from "@/server/errors";
import { ingest, readIncomingBody } from "@/server/hook-listeners";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ token: string; path?: string[] }> };

/**
 * The public receiving end of an incoming webhook listener. The token in the URL is the credential,
 * so nothing here reveals whether a token exists, and the response never contains request data.
 */
async function handle(request: Request, { params }: Context): Promise<Response> {
  const { token } = await params;
  const secure = {
    "Cache-Control": "no-store",
    "Content-Security-Policy": "sandbox; default-src 'none'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  };
  try {
    const url = new URL(request.url);
    const body = await readIncomingBody(request);
    const prefix = `/hook/${token}`;
    const result = ingest(token, {
      method: request.method,
      path: url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : "",
      query: url.search.replace(/^\?/, ""),
      headers: [...request.headers.entries()],
      body,
    });
    return new Response(result.body, {
      status: result.status,
      headers: { ...secure, "Content-Type": result.contentType, ...result.headers },
    });
  } catch (error) {
    if (error instanceof HttpError)
      return Response.json({ error: error.message }, { status: error.status, headers: secure });
    console.error("[postbox] hook listener error:", error);
    return Response.json({ error: "Internal error" }, { status: 500, headers: secure });
  }
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
