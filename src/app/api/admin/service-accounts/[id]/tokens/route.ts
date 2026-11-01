/**
 * POST /api/admin/service-accounts/:id/tokens { name, scope?, expiresInDays?, rateLimitPerMinute? } —
 * issue a key for a service account. The key is returned once. Administrators only.
 */
import { keyOptionsSchema } from "@/server/key-input";
import { HttpError, json, parseBody, route } from "@/server/http";
import { createToken, getUser } from "@/server/users";

export const dynamic = "force-dynamic";

export const POST = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const account = getUser((await params).id);
  if (!account?.isService) throw new HttpError(404, "Service account not found");
  if (account.disabled) throw new HttpError(409, "This service account is disabled");
  const input = await parseBody(req, keyOptionsSchema);
  const { token, info } = createToken(account.id, input.name, input.expiresInDays, input);
  return json({ ...info, token }, 201);
});
