/**
 * Who is making a request. Used by the proxy gate, auth routes and (later)
 * workspace authorization, so every entry point resolves identity the same way.
 */
import type { KeyScope } from "@/core/scopes";
import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  bearerToken,
  createUserSession,
  getAuthConfig,
  parseUserSession,
  safeEqual,
  sessionExpiry,
  verifySession,
  type AuthConfig,
} from "./auth";
import type { UserRow } from "./db/schema";
import { callerScope } from "./access-context";
import { HttpError } from "./errors";
import { cachedValue } from "./db-cache";
import { isSessionRevoked, revokeSession, sessionEpoch, sessionTtl } from "./session-settings";
import { countUsers, getUser, resolveTokenInfo, storedSecret, toPublicUser, type PublicUser } from "./users";

export type Caller =
  /** Authentication is off (no credentials, no accounts). */
  | { kind: "open" }
  /** POSTBOX_PASSWORD / POSTBOX_TOKEN: the bootstrap and recovery administrator. */
  | { kind: "env" }
  | {
      kind: "user";
      user: UserRow;
      via: "session" | "token";
      /** Set when the caller authenticated with an API key: the key's own scope and limit. */
      token?: { id: string; scope: KeyScope; rateLimitPerMinute: number | null };
    };

export const isAdmin = (c: Caller) => c.kind !== "user" || c.user.isAdmin;

export interface AuthState {
  cfg: AuthConfig | null;
  hasUsers: boolean;
  enabled: boolean;
}

/** The environment variables the auth state depends on, hashed so the cache key holds no secret. */
function authEnvKey(env: NodeJS.ProcessEnv): string {
  const parts = [
    env.POSTBOX_PASSWORD,
    env.POSTBOX_TOKEN,
    env.POSTBOX_SESSION_SECRET,
    env.POSTBOX_SESSION_DAYS,
  ];
  return createHash("sha256")
    .update(parts.map((p) => p ?? "").join("\0"))
    .digest("base64url");
}

/**
 * Whether sign-in is required and with which credentials. Cached until the database or these
 * environment variables change.
 */
export function getAuthState(): AuthState {
  return cachedValue(`authState:${authEnvKey(process.env)}`, () => {
    const cfg = getAuthConfig(process.env, { epoch: sessionEpoch(), sessionTtlMs: sessionTtl() });
    const hasUsers = countUsers() > 0;
    return { cfg, hasUsers, enabled: !!cfg || hasUsers };
  });
}

/**
 * Signing key for account sessions: POSTBOX_SESSION_SECRET, else one generated and stored on
 * first use. Unlike single-user (v1) cookies it does not depend on the env credentials, so
 * adding or removing POSTBOX_PASSWORD does not sign everyone out.
 */
export function sessionSecret(): Buffer {
  if (process.env.POSTBOX_SESSION_SECRET)
    return createHash("sha256")
      .update(`postbox-account-session\0${process.env.POSTBOX_SESSION_SECRET}`)
      .digest();
  return storedSecret("session");
}

/**
 * How long a resolved caller is reused for the same credentials. Within one request the gate and
 * the route handler resolve the same caller; any database write (a disabled user, a revoked key
 * or session) ends the reuse at once, so this only bounds how long expiry checks can lag.
 */
const CALLER_REUSE_MS = 1000;

interface ResolvedCaller {
  state: AuthState;
  at: number;
  caller: Caller | null;
}

/** Resolve the caller from the Authorization header and session cookie; null means unauthenticated. */
export function getCaller(
  headers: Headers,
  cookie: string | undefined,
  state = getAuthState(),
): Caller | null {
  if (!state.enabled) return { kind: "open" };
  const now = Date.now();
  const credentials = createHash("sha256")
    .update(`${headers.get("authorization") ?? ""}\0${cookie ?? ""}`)
    .digest("base64url");
  return cachedValue<ResolvedCaller>(
    `caller:${credentials}`,
    () => ({ state, at: now, caller: resolveCaller(headers, cookie, state) }),
    (hit) => sameAuthState(hit.state, state) && now - hit.at >= 0 && now - hit.at < CALLER_REUSE_MS,
  ).caller;
}

function sameAuthState(a: AuthState, b: AuthState): boolean {
  if (a === b) return true;
  if (a.enabled !== b.enabled || a.hasUsers !== b.hasUsers) return false;
  if (!a.cfg || !b.cfg) return a.cfg === b.cfg;
  return (
    a.cfg.password === b.cfg.password &&
    a.cfg.token === b.cfg.token &&
    a.cfg.sessionTtlMs === b.cfg.sessionTtlMs &&
    a.cfg.secret.equals(b.cfg.secret)
  );
}

function resolveCaller(headers: Headers, cookie: string | undefined, state: AuthState): Caller | null {
  const bearer = bearerToken(headers.get("authorization"));
  if (bearer) {
    if (state.cfg?.token && safeEqual(bearer, state.cfg.token)) return { kind: "env" };
    const resolved = resolveTokenInfo(bearer);
    return resolved ? { kind: "user", user: resolved.user, via: "token", token: resolved.token } : null;
  }
  if (!cookie) return null;
  const session = parseUserSession(sessionSecret(), cookie);
  if (session) {
    const user = getUser(session.userId);
    if (!user || user.disabled || user.sessionVersion !== session.sessionVersion) return null;
    if (isSessionRevoked(cookie)) return null;
    return { kind: "user", user, via: "session" };
  }
  // Single-user cookies stay valid only until the first account is created.
  if (!state.hasUsers && state.cfg && verifySession(state.cfg, cookie) && !isSessionRevoked(cookie))
    return { kind: "env" };
  return null;
}

/** The session cookie sent with a route handler request, if any. */
function sessionCookieOf(req: Request): string | undefined {
  const cookie = req.headers
    .get("cookie")
    ?.split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);
  return cookie ? decodeCookie(cookie) : undefined;
}

/**
 * Sign-out: end the request's browser session on the server, so a copy of the cookie stops
 * working too. Only a correctly signed, unexpired cookie is recorded. Other sessions of the
 * same user are not affected; "Sign out of all sessions" ends those.
 */
export function endBrowserSession(req: Request, now = Date.now()) {
  const cookie = sessionCookieOf(req);
  if (!cookie) return;
  const cfg = getAuthState().cfg;
  const valid =
    !!parseUserSession(sessionSecret(), cookie, now) || (!!cfg && verifySession(cfg, cookie, now));
  if (valid) revokeSession(cookie, sessionExpiry(cookie), now);
}

/** Percent-decoded cookie value; a malformed one counts as no cookie rather than an error. */
function decodeCookie(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

/** Caller of a route handler request. */
export function callerOf(req: Request): Caller | null {
  return getCaller(req.headers, sessionCookieOf(req));
}

/** The signed-in account, or 401 / 400 for env and open callers that have no account. */
export function requireUser(req: Request): UserRow {
  const caller = callerOf(req);
  if (!caller) throw new HttpError(401, "Authentication required");
  if (caller.kind !== "user") throw new HttpError(400, "Sign in with a user account to manage it");
  return caller.user;
}

export function describeCaller(c: Caller | null): {
  kind: Caller["kind"] | "anonymous";
  user: PublicUser | null;
  isAdmin: boolean;
  scope: KeyScope;
} {
  if (!c) return { kind: "anonymous", user: null, isAdmin: false, scope: "read" };
  return {
    kind: c.kind,
    user: c.kind === "user" ? toPublicUser(c.user) : null,
    isAdmin: isAdmin(c),
    scope: callerScope(c),
  };
}

/** Whether the request reached Postbox over HTTPS (directly or behind a TLS proxy). */
export const isSecure = (req: Pick<Request, "url" | "headers">) =>
  new URL(req.url).protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";

/** Attach a fresh account session cookie to a response. */
export function setUserSessionCookie(res: NextResponse, req: Request, user: UserRow) {
  const session = createUserSession(sessionSecret(), user, sessionTtl());
  res.cookies.set(SESSION_COOKIE, session.value, {
    httpOnly: true,
    sameSite: "lax",
    secure: isSecure(req),
    path: "/",
    expires: session.expires,
  });
  return res;
}
