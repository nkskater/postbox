/** GET /api/auth/status — whether login is required, whether the first account is still missing, and who is calling. */
import { NextResponse } from "next/server";
import { callerOf, describeCaller, getAuthState } from "@/server/caller";

export const dynamic = "force-dynamic";

export function GET(req: Request) {
  const state = getAuthState();
  return NextResponse.json({
    authEnabled: state.enabled,
    hasUsers: state.hasUsers,
    envCredentials: !!state.cfg,
    caller: describeCaller(callerOf(req)),
  });
}
