/** POST /api/auth/login { password } — issue a session cookie. */
import { NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  clearLoginFailures,
  clientKey,
  createSession,
  getAuthConfig,
  loginAllowed,
  recordLoginFailure,
  verifyLoginSecret,
} from "@/server/auth";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const cfg = getAuthConfig();
  if (!cfg) return NextResponse.json({ ok: true, authDisabled: true });
  const key = clientKey(req.headers);
  if (!loginAllowed(key)) {
    return NextResponse.json(
      { error: "Too many failed attempts. Try again in a few minutes." },
      { status: 429 },
    );
  }
  let password = "";
  try {
    password = String(((await req.json()) as { password?: unknown }).password ?? "");
  } catch {
    /* treated as an empty password */
  }
  if (!password || !verifyLoginSecret(cfg, password)) {
    recordLoginFailure(key);
    return NextResponse.json({ error: "Invalid password" }, { status: 401 });
  }
  clearLoginFailures(key);
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
