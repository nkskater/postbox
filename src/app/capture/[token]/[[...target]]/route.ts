import { parseRelayTarget } from "@/core/capture";
import { readRelayBody, relay } from "@/server/capture";
import { HttpError } from "@/server/errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ token: string; target?: string[] }> };

/**
 * The recording relay: `/capture/<token>/<absolute URL>`. The token in the URL is the credential,
 * so nothing here reveals whether a token exists. The target is checked by the session's rules and
 * the outbound host policy before anything is sent.
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
    if (request.headers.get("sec-fetch-mode")?.trim().toLowerCase() === "navigate")
      return Response.json(
        { error: "Browser navigation is disabled for the capture relay" },
        { status: 403, headers: secure },
      );
    const url = new URL(request.url);
    const prefix = `/capture/${token}`;
    const rest = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : "";
    const target = parseRelayTarget(rest, url.search);
    if (!target)
      return Response.json(
        { error: "Put the full URL after the token: /capture/<token>/https://example.com/path" },
        { status: 400, headers: secure },
      );
    const body = await readRelayBody(request);
    const result = await relay(token, {
      method: request.method,
      target,
      headers: [...request.headers.entries()],
      body,
    });
    const headers = new Headers();
    for (const [name, value] of result.headers) {
      try {
        headers.append(name, value);
      } catch {
        /* a header Node cannot forward */
      }
    }
    for (const [name, value] of Object.entries(secure)) headers.set(name, value);
    return new Response(result.body.length ? new Uint8Array(result.body) : null, {
      status: result.status,
      headers,
    });
  } catch (error) {
    if (error instanceof HttpError)
      return Response.json({ error: error.message }, { status: error.status, headers: secure });
    console.error("[postbox] capture relay error:", error);
    return Response.json({ error: "Internal error" }, { status: 500, headers: secure });
  }
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const HEAD = handle;
export const OPTIONS = handle;
