/**
 * POST /api/auth/login — issue a session cookie.
 *   With accounts:    { username, password } → account session (v2).
 *   Without accounts: { password } checked against POSTBOX_PASSWORD / POSTBOX_TOKEN (v1).
 */
import { NextResponse } from "next/server";
import {
  LOGIN_BODY_LIMIT,
  MAX_PASSWORD_LENGTH,
  SESSION_COOKIE,
  clearLoginFailures,
  createSession,
  loginAllowed,
  loginKeys,
  recordLoginFailure,
  verifyLoginSecret,
} from "@/server/auth";
import { clientAddress } from "@/server/client-address";
import { HttpError, readBodyText } from "@/server/http";
import { getAuthState, setUserSessionCookie } from "@/server/caller";
import { audit } from "@/server/audit";
import { burnPasswordCheck, getUserByUsername, normalizeUsername, verifyPassword } from "@/server/users";

export const dynamic = "force-dynamic";

const tooMany = () =>
  NextResponse.json({ error: "Too many failed attempts. Try again in a few minutes." }, { status: 429 });

export async function POST(req: Request) {
  const state = getAuthState();
  if (!state.enabled) return NextResponse.json({ ok: true, authDisabled: true });
  let body: { username?: unknown; password?: unknown } = {};
  try {
    // Unauthenticated: read a small body only, and never hash an oversized password.
    body = JSON.parse(await readBodyText(req, LOGIN_BODY_LIMIT)) as typeof body;
  } catch (error) {
    if (error instanceof HttpError)
      return NextResponse.json({ error: error.message }, { status: error.status });
    /* malformed JSON is treated as empty credentials */
  }
  if (!body || typeof body !== "object") body = {};
  const password = String(body.password ?? "");
  if (password.length > MAX_PASSWORD_LENGTH)
    return NextResponse.json({ error: "Invalid username or password" }, { status: 400 });
  const address = clientAddress(req.headers);
  const ipKey = loginKeys.client(address);

  if (state.hasUsers) {
    const username = normalizeUsername(String(body.username ?? "")).slice(0, 64);
    // Per client, per (account, client) and a high account-wide ceiling: one address cannot
    // lock out others, strangers cannot lock out an account, and many addresses cannot guess one.
    const pairKey = loginKeys.pair(username, address);
    const accountKey = loginKeys.account(username);
    if (!loginAllowed(ipKey) || !loginAllowed(pairKey) || !loginAllowed(accountKey)) return tooMany();
    const user = username ? getUserByUsername(username) : undefined;
    let ok = false;
    if (user && !user.isService && password) ok = await verifyPassword(password, user.passwordHash);
    else await burnPasswordCheck(password); // also for service accounts, which have no password
    if (!ok || !user || user.disabled) {
      recordLoginFailure(ipKey);
      recordLoginFailure(pairKey);
      recordLoginFailure(accountKey);
      audit({
        action: "auth.login_failed",
        entityKind: "session",
        entityName: username.slice(0, 64),
        result: "denied",
        actor: { name: username.slice(0, 64) || "unknown", kind: "user" },
      });
      return NextResponse.json({ error: "Invalid username or password" }, { status: 401 });
    }
    clearLoginFailures(ipKey);
    clearLoginFailures(pairKey);
    audit({
      action: "auth.login",
      entityKind: "session",
      entityName: user.username,
      actor: { id: user.id, name: user.username, kind: "user" },
      via: "session",
    });
    return setUserSessionCookie(NextResponse.json({ ok: true }), req, user);
  }

  const cfg = state.cfg!;
  // Single-user mode has one secret, so failures also count against it from every address.
  const secretKey = loginKeys.secret();
  if (!loginAllowed(ipKey) || !loginAllowed(secretKey)) return tooMany();
  if (!password || !verifyLoginSecret(cfg, password)) {
    recordLoginFailure(ipKey);
    recordLoginFailure(secretKey);
    return NextResponse.json({ error: "Invalid password" }, { status: 401 });
  }
  clearLoginFailures(ipKey);
  const session = createSession(cfg);
  const secure = new URL(req.url).protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, session.value, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    expires: session.expires,
  });
  return res;
}
