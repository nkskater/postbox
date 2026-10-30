/**
 * GET  /api/me/tokens — the caller's active API tokens (metadata only).
 * POST /api/me/tokens { name, expiresInDays? } — create a token; the value is returned once.
 */
import { z } from "zod";
import { requireUser } from "@/server/caller";
import { json, parseBody, route } from "@/server/http";
import { createToken, listTokens } from "@/server/users";

export const dynamic = "force-dynamic";

export const GET = route((req: Request) => json(listTokens(requireUser(req).id)));

export const POST = route(async (req: Request) => {
  const user = requireUser(req);
  const input = await parseBody(
    req,
    z.object({
      name: z.string().max(100),
      expiresInDays: z.number().int().min(1).max(3650).nullish(),
    }),
  );
  const { token, info } = createToken(user.id, input.name, input.expiresInDays);
  return json({ ...info, token }, 201);
});
