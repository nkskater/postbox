/**
 * POST /api/admin/sessions/revoke — sign out every browser session (accounts and the
 * single-user password login), including the caller's. API tokens and POSTBOX_TOKEN keep
 * working. Administrators only.
 */
import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/server/auth";
import { requireAdmin } from "@/server/authorize";
import { route } from "@/server/http";
import { signOutEveryone } from "@/server/session-settings";

export const dynamic = "force-dynamic";

export const POST = route(() => {
  requireAdmin();
  const { users } = signOutEveryone();
  const res = NextResponse.json({ ok: true, users });
  res.cookies.set(SESSION_COOKIE, "", { path: "/", expires: new Date(0) });
  return res;
});
