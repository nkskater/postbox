/**
 * Request gate (Next.js 16 "proxy", formerly middleware). Enforces authentication
 * (env credentials or user accounts) for the UI and every API route, including /api/mcp.
 */
import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, isPublicPath } from "@/server/auth";
import { FixedWindowLimiter } from "@/core/ratelimit";
import { getAuthState, getCaller } from "@/server/caller";

let warned = false;
/** Per-key request counters (one minute windows). Counted here, once per request, never in the resolver. */
export const keyLimiter = new FixedWindowLimiter();

export function proxy(req: NextRequest) {
  const state = getAuthState();
  if (!state.enabled) {
    if (!warned) {
      warned = true;
      console.warn(
        "[postbox] Authentication is disabled. Create an account under Profile, or set POSTBOX_PASSWORD and/or POSTBOX_TOKEN.",
      );
    }
    return NextResponse.next();
  }
  const { pathname, search } = req.nextUrl;
  if (isPublicPath(pathname)) return NextResponse.next();
  const caller = getCaller(req.headers, req.cookies.get(SESSION_COOKIE)?.value, state);
  if (caller) {
    const key = caller.kind === "user" ? caller.token : undefined;
    const limit = key?.rateLimitPerMinute;
    if (!key || !limit) return NextResponse.next();
    const d = keyLimiter.hit(key.id, limit, 60_000, Date.now());
    const headers = {
      "X-RateLimit-Limit": String(d.limit),
      "X-RateLimit-Remaining": String(d.remaining),
      "X-RateLimit-Reset": String(d.resetSeconds),
    };
    if (d.allowed) {
      const res = NextResponse.next();
      for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
      return res;
    }
    return NextResponse.json(
      { error: `Rate limit of ${limit} requests per minute exceeded for this API key` },
      { status: 429, headers: { ...headers, "Retry-After": String(d.resetSeconds) } },
    );
  }
  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: "Authentication required" },
      { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="postbox"' } },
    );
  }
  const login = new URL("/login", req.url);
  if (pathname !== "/") login.searchParams.set("next", `${pathname}${search}`);
  return NextResponse.redirect(login);
}

export const config = {
  // Static assets are excluded for speed; everything else goes through the gate.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
