/**
 * Request gate (Next.js 16 "proxy", formerly middleware). Enforces the optional
 * single-user auth for the UI and every API route, including /api/mcp.
 */
import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, getAuthConfig, isPublicPath, verifyBearer, verifySession } from "@/server/auth";

let warned = false;

export function proxy(req: NextRequest) {
  const cfg = getAuthConfig();
  if (!cfg) {
    if (!warned) {
      warned = true;
      console.warn(
        "[postbox] Authentication is disabled. Set POSTBOX_PASSWORD and/or POSTBOX_TOKEN to require login.",
      );
    }
    return NextResponse.next();
  }
  const { pathname, search } = req.nextUrl;
  if (isPublicPath(pathname)) return NextResponse.next();
  if (
    verifySession(cfg, req.cookies.get(SESSION_COOKIE)?.value) ||
    verifyBearer(cfg, req.headers.get("authorization"))
  ) {
    return NextResponse.next();
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
