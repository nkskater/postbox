/**
 * POST /api/auth/login — issue a session cookie.
 *   With accounts:    { username, password } → account session (v2).
 *   Without accounts: { password } checked against POSTBOX_PASSWORD / POSTBOX_TOKEN (v1).
 */
import { NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  clearLoginFailures,
  clientKey,
  createSession,
  loginAllowed,
  recordLoginFailure,
  verifyLoginSecret,
} from "@/server/auth";
import { getAuthState, setUserSessionCookie } from "@/server/caller";
import { burnPasswordCheck, getUserByUsername, normalizeUsername, verifyPassword } from "@/server/users";

export const dynamic = "force-dynamic";

const tooMany = () =>
  NextResponse.json({ error: "Too many failed attempts. Try again in a few minutes." }, { status: 429 });

export async function POST(req: Request) {
  const state = getAuthState();
  if (!state.enabled) return NextResponse.json({ ok: true, authDisabled: true });
  let body: { username?: unknown; password?: unknown } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    /* treated as empty credentials */
  }
  const password = String(body.password ?? "");
  const ipKey = clientKey(req.headers);

  if (state.hasUsers) {
    const username = normalizeUsername(String(body.username ?? ""));
    // Limit per client and per account, so one address cannot lock out others and
    // many addresses cannot guess one account's password.
    const userKey = `user:${username}`;
    if (!loginAllowed(ipKey) || !loginAllowed(userKey)) return tooMany();
    const user = username ? getUserByUsername(username) : undefined;
    let ok = false;
    if (user && password) ok = await verifyPassword(password, user.passwordHash);
    else await burnPasswordCheck(password);
    if (!ok || !user || user.disabled) {
      recordLoginFailure(ipKey);
      recordLoginFailure(userKey);
      return NextResponse.json({ error: "Invalid username or password" }, { status: 401 });
    }
    clearLoginFailures(ipKey);
    clearLoginFailures(userKey);
    return setUserSessionCookie(NextResponse.json({ ok: true }), req, user);
  }

  const cfg = state.cfg!;
  if (!loginAllowed(ipKey)) return tooMany();
  if (!password || !verifyLoginSecret(cfg, password)) {
    recordLoginFailure(ipKey);
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
