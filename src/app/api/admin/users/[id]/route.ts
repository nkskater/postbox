import { z } from "zod";
import { json, parseBody, route } from "@/server/http";
import { updateManagedUser, toPublicUser } from "@/server/users";
type Ctx = { params: Promise<{ id: string }> };
export const PATCH = route(async (req: Request, { params }: Ctx) => {
  const input = await parseBody(
    req,
    z
      .object({
        displayName: z.string().max(200).optional(),
        password: z.string().max(1024).optional(),
        disabled: z.boolean().optional(),
        isAdmin: z.boolean().optional(),
      })
      .strict(),
  );
  return json(toPublicUser(await updateManagedUser((await params).id, input)));
});
