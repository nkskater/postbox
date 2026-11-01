/**
 * POST /api/admin/tokens/:id/rotate { graceMinutes? } — replace a key with a new one of the same owner,
 * scope, expiry period and limit. The old key stops working after the grace period (default: at once).
 * The new key is returned once. Administrators only.
 */
import { rotateInput, rotateResponse } from "@/server/key-input";
import { json, notFound, parseBody, route } from "@/server/http";
import { rotateToken } from "@/server/users";

export const dynamic = "force-dynamic";

export const POST = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const input = await parseBody(req, rotateInput);
  const rotated = rotateToken((await params).id, input.graceMinutes);
  if (!rotated) throw notFound("Key");
  return json(rotateResponse(rotated), 201);
});
