/**
 * POST /api/auth/setup { username, password, displayName? } — create the first
 * (administrator) account and sign in as it. Only possible while no account exists,
 * and only for the env-credential admin when POSTBOX_PASSWORD / POSTBOX_TOKEN are set.
 */
import { z } from "zod";
import { callerOf, getAuthState, setUserSessionCookie } from "@/server/caller";
import { HttpError, json, parseBody, route } from "@/server/http";
import { insertPreparedUser, prepareUser, toPublicUser } from "@/server/users";

export const dynamic = "force-dynamic";

export const POST = route(async (req: Request) => {
  const state = getAuthState();
  if (state.hasUsers) throw new HttpError(409, "An account already exists; sign in instead");
  if (state.cfg && callerOf(req)?.kind !== "env")
    throw new HttpError(401, "Sign in with POSTBOX_PASSWORD or POSTBOX_TOKEN first");
  const input = await parseBody(
    req,
    z.object({
      username: z.string().max(64),
      password: z.string().max(1024),
      displayName: z.string().max(200).optional(),
    }),
  );
  // The early hasUsers check only saves work; the insert re-checks atomically after the
  // (slow) password hash, which is where concurrent requests would otherwise interleave.
  const user = insertPreparedUser(await prepareUser({ ...input, isAdmin: true }), { firstOnly: true });
  return setUserSessionCookie(json({ user: toPublicUser(user) }, 201), req, user);
});
