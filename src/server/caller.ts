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
  verifySession,
  type AuthConfig,
} from "./auth";
import type { UserRow } from "./db/schema";
import { callerScope } from "./access-context";
import { HttpError } from "./errors";
import { sessionEpoch, sessionTtl } from "./session-settings";
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

export function getAuthState(): AuthState {
  const cfg = getAuthConfig(process.env, { epoch: sessionEpoch(), sessionTtlMs: sessionTtl() });
  const hasUsers = countUsers() > 0;
  return { cfg, hasUsers, enabled: !!cfg || hasUsers };
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

/** Resolve the caller from the Authorization header and session cookie; null means unauthenticated. */
export function getCaller(
  headers: Headers,
  cookie: string | undefined,
  state = getAuthState(),
): Caller | null {
  if (!state.enabled) return { kind: "open" };
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
    return { kind: "user", user, via: "session" };
  }
  // Single-user cookies stay valid only until the first account is created.
  if (!state.hasUsers && state.cfg && verifySession(state.cfg, cookie)) return { kind: "env" };
  return null;
}

/** Caller of a route handler request. */
export function callerOf(req: Request): Caller | null {
  const cookie = req.headers
    .get("cookie")
    ?.split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);
  return getCaller(req.headers, cookie ? decodeURIComponent(cookie) : undefined);
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

const isSecure = (req: Request) =>
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
