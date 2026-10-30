/**
 * Request gate (Next.js 16 "proxy", formerly middleware). Enforces authentication
 * (env credentials or user accounts) for the UI and every API route, including /api/mcp.
 */
import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, isPublicPath } from "@/server/auth";
import { getAuthState, getCaller } from "@/server/caller";

let warned = false;

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
  if (getCaller(req.headers, req.cookies.get(SESSION_COOKIE)?.value, state)) return NextResponse.next();
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
