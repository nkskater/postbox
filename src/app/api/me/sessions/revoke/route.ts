/**
 * POST /api/me/sessions/revoke — "Sign out of all sessions" for the signed-in account: every
 * browser session of the user ends, including this one. API tokens keep working.
 */
import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/server/auth";
import { requireUser } from "@/server/caller";
import { route } from "@/server/http";
import { signOutAllSessions } from "@/server/users";

export const dynamic = "force-dynamic";

export const POST = route((req: Request) => {
  const user = requireUser(req);
  signOutAllSessions(user.id);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
  return res;
});
