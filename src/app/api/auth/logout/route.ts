/**
 * POST /api/auth/logout — sign out: end this browser session on the server (a copy of the
 * cookie stops working too) and clear the cookie. Other sessions of the user are unaffected.
 */
import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/server/auth";
import { endBrowserSession } from "@/server/caller";

export function POST(req: Request) {
  endBrowserSession(req);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
  return res;
}
