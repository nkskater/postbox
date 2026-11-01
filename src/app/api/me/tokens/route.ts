/**
 * GET  /api/me/tokens — the caller's active API tokens (metadata only).
 * POST /api/me/tokens { name, scope?, expiresInDays?, rateLimitPerMinute? } — create a key; the value is returned once.
 *      scope is read, run, write or full (default); a key can never do more than its owner.
 */
import { keyOptionsSchema } from "@/server/key-input";
import { requireUser } from "@/server/caller";
import { json, parseBody, route } from "@/server/http";
import { createToken, listTokens } from "@/server/users";

export const dynamic = "force-dynamic";

export const GET = route((req: Request) => json(listTokens(requireUser(req).id)));

export const POST = route(async (req: Request) => {
  const user = requireUser(req);
  const input = await parseBody(req, keyOptionsSchema);
  const { token, info } = createToken(user.id, input.name, input.expiresInDays, input);
  return json({ ...info, token }, 201);
});
