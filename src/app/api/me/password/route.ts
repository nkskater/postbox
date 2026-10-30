/** POST /api/me/password { currentPassword, newPassword } — change password; other sessions end. */
import { z } from "zod";
import { requireUser, setUserSessionCookie } from "@/server/caller";
import { HttpError, json, parseBody, route } from "@/server/http";
import { setPassword, verifyPassword } from "@/server/users";

export const POST = route(async (req: Request) => {
  const user = requireUser(req);
  const input = await parseBody(
    req,
    z.object({ currentPassword: z.string().max(1024), newPassword: z.string().max(1024) }),
  );
  if (!(await verifyPassword(input.currentPassword, user.passwordHash)))
    throw new HttpError(403, "Current password is incorrect");
  const updated = await setPassword(user.id, input.newPassword);
  // Keep this browser signed in with a cookie for the new session version.
  return setUserSessionCookie(json({ ok: true }), req, updated);
});
