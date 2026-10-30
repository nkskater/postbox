import { z } from "zod";
import { HttpError, json, parseBody, route } from "@/server/http";
import { countUsers, createUser, listUsers, toPublicUser } from "@/server/users";
export const GET = route((_req: Request) => json(listUsers().map(toPublicUser)));
export const POST = route(async (req: Request) => {
  if (!countUsers()) throw new HttpError(409, "Create the initial administrator under Profile first");
  const input = await parseBody(
    req,
    z
      .object({
        username: z.string().max(64),
        password: z.string().max(1024),
        displayName: z.string().max(200).optional(),
        isAdmin: z.boolean().optional(),
      })
      .strict(),
  );
  return json(toPublicUser(await createUser(input)), 201);
});
