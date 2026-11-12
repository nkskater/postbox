import { z } from "zod";
import { acceptInvite } from "@/server/invites";
import { HttpError, json, readBodyText, route } from "@/server/http";
import { setUserSessionCookie } from "@/server/caller";
import { toPublicUser } from "@/server/users";
import {
  LOGIN_BODY_LIMIT,
  clearLoginFailures,
  loginAllowed,
  loginKeys,
  recordLoginFailure,
} from "@/server/auth";
import { clientAddress } from "@/server/client-address";
export const POST = route(async (req: Request) => {
  const key = loginKeys.invite(clientAddress(req.headers));
  if (!loginAllowed(key)) throw new HttpError(429, "Too many attempts. Try again later.");
  let data: unknown;
  try {
    data = JSON.parse(await readBodyText(req, LOGIN_BODY_LIMIT));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "Body must be valid JSON");
  }
  const { token, ...account } = z
    .object({
      token: z.string().min(32).max(100),
      username: z.string().max(64),
      displayName: z.string().max(200).optional(),
      password: z.string().max(1024),
    })
    .strict()
    .parse(data);
  try {
    const user = await acceptInvite(token, account);
    clearLoginFailures(key);
    return setUserSessionCookie(json({ user: toPublicUser(user) }, 201), req, user);
  } catch (error) {
    recordLoginFailure(key);
    throw error;
  }
});
