import { z } from "zod";
import { acceptInvite } from "@/server/invites";
import { HttpError, json, parseBody, route } from "@/server/http";
import { setUserSessionCookie } from "@/server/caller";
import { toPublicUser } from "@/server/users";
import { clientKey, loginAllowed, recordLoginFailure, clearLoginFailures } from "@/server/auth";
export const POST = route(async (req: Request) => {
  const key = `invite:${clientKey(req.headers)}`;
  if (!loginAllowed(key)) throw new HttpError(429, "Too many attempts. Try again later.");
  const { token, ...account } = await parseBody(
    req,
    z
      .object({
        token: z.string().min(32).max(100),
        username: z.string().max(64),
        displayName: z.string().max(200).optional(),
        password: z.string().max(1024),
      })
      .strict(),
  );
  try {
    const user = await acceptInvite(token, account);
    clearLoginFailures(key);
    return setUserSessionCookie(json({ user: toPublicUser(user) }, 201), req, user);
  } catch (error) {
    recordLoginFailure(key);
    throw error;
  }
});
