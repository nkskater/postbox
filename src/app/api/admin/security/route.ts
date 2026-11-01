/**
 * GET /api/admin/security — sign-in status, session length and version information for
 * Settings → Security & about. Reports whether credentials are configured, never their values.
 * Administrators only.
 */
import pkg from "../../../../../package.json";
import { requireAdmin } from "@/server/authorize";
import { getAuthState } from "@/server/caller";
import { json, route } from "@/server/http";
import { sessionTtl } from "@/server/session-settings";

export const dynamic = "force-dynamic";

export const GET = route(() => {
  requireAdmin();
  const state = getAuthState();
  return json({
    version: pkg.version,
    commit: process.env.POSTBOX_COMMIT || null,
    node: process.version,
    auth: {
      mode: state.hasUsers ? "accounts" : state.cfg ? "password" : "open",
      passwordConfigured: !!state.cfg?.password,
      tokenConfigured: !!state.cfg?.token,
    },
    sessionDays: Math.round(sessionTtl() / 86_400_000),
  });
});
