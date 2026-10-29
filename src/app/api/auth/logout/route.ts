/** POST /api/auth/logout — clear the session cookie. */
import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/server/auth";

export function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
  return res;
}
