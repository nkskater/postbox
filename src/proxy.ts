/**
 * Request gate (Next.js 16 "proxy", formerly middleware). Enforces authentication
 * (env credentials or user accounts) for the UI and every API route, including /api/mcp.
 */
import { NextResponse, type NextRequest } from "next/server";
import {
  SESSION_COOKIE,
  bearerToken,
  isPublicPath,
  loginAllowed,
  loginKeys,
  recordLoginFailure,
} from "@/server/auth";
import { clientAddress } from "@/server/client-address";
import { FixedWindowLimiter } from "@/core/ratelimit";
import { getAuthState, getCaller, isSecure } from "@/server/caller";
import { HSTS, appCsp, appliesCsp, newNonce } from "@/server/csp";
import { isCrossOriginWrite } from "@/server/request-origin";

let warned = false;
/** Per-key request counters (one minute windows). Counted here, once per request, never in the resolver. */
export const keyLimiter = new FixedWindowLimiter();

/**
 * API routes whose cross-origin writes are checked. Public receivers (mocks, hooks, capture,
 * telemetry ingest) accept requests from anywhere by design, and /api/mcp applies its own
 * configurable origin allow-list. The sign-in routes stay covered: they issue the cookie.
 */
function guardsOrigin(pathname: string): boolean {
  // SAML POST callbacks authenticate the signed assertion and one-use browser-bound RelayState.
  if (/^\/api\/auth\/sso\/[a-zA-Z0-9_-]+\/callback$/.test(pathname)) return false;
  if (!pathname.startsWith("/api/") || pathname === "/api/mcp") return false;
  return pathname.startsWith("/api/auth/") || !isPublicPath(pathname);
}

export function proxy(req: NextRequest) {
  const res = gate(req);
  // Headers for every response the gate lets through or answers itself.
  if (isSecure(req)) res.headers.set("Strict-Transport-Security", HSTS);
  return res;
}

/** NextResponse.next(), carrying a per-request CSP nonce for app pages. */
function pass(req: NextRequest): NextResponse {
  if (!appliesCsp(req.nextUrl.pathname)) return NextResponse.next();
  const nonce = newNonce();
  const policy = appCsp(nonce);
  // Next.js reads the nonce from the request's CSP header and adds it to its scripts.
  const headers = new Headers(req.headers);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", policy);
  const res = NextResponse.next({ request: { headers } });
  res.headers.set("Content-Security-Policy", policy);
  return res;
}

function gate(req: NextRequest): NextResponse {
  if (guardsOrigin(req.nextUrl.pathname) && isCrossOriginWrite(req.method, req.headers, req.url))
    return NextResponse.json({ error: "Cross-origin request rejected" }, { status: 403 });
  const state = getAuthState();
  if (!state.enabled) {
    if (!warned) {
      warned = true;
      console.warn(
        "[postbox] Authentication is disabled. Create an account under Profile, or set POSTBOX_PASSWORD and/or POSTBOX_TOKEN.",
      );
    }
    return pass(req);
  }
  const { pathname, search } = req.nextUrl;
  if (isPublicPath(pathname)) return pass(req);
  // A configured POSTBOX_TOKEN is a guessable secret: throttle failed bearer attempts like logins.
  const guarded = Boolean(state.cfg?.token && bearerToken(req.headers.get("authorization")));
  const clientKey = loginKeys.client(clientAddress(req.headers));
  const secretKey = loginKeys.secret();
  if (guarded && (!loginAllowed(clientKey) || (!state.hasUsers && !loginAllowed(secretKey))))
    return NextResponse.json(
      { error: "Too many failed attempts. Try again in a few minutes." },
      { status: 429, headers: { "Retry-After": "300" } },
    );
  const caller = getCaller(req.headers, req.cookies.get(SESSION_COOKIE)?.value, state);
  if (!caller && guarded) {
    recordLoginFailure(clientKey);
    if (!state.hasUsers) recordLoginFailure(secretKey);
  }
  if (caller) {
    const key = caller.kind === "user" ? caller.token : undefined;
    const limit = key?.rateLimitPerMinute;
    if (!key || !limit) return pass(req);
    const d = keyLimiter.hit(key.id, limit, 60_000, Date.now());
    const headers = {
      "X-RateLimit-Limit": String(d.limit),
      "X-RateLimit-Remaining": String(d.remaining),
      "X-RateLimit-Reset": String(d.resetSeconds),
    };
    if (d.allowed) {
      const res = pass(req);
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
