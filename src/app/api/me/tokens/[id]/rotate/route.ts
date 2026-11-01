/**
 * POST /api/me/tokens/:id/rotate { graceMinutes? } — rotate one of the caller's own keys (see
 * /api/admin/tokens/:id/rotate). The new key is returned once.
 */
import { requireUser } from "@/server/caller";
import { rotateInput, rotateResponse } from "@/server/key-input";
import { json, notFound, parseBody, route } from "@/server/http";
import { getTokenRow, rotateToken } from "@/server/users";

export const dynamic = "force-dynamic";

export const POST = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const user = requireUser(req);
  const input = await parseBody(req, rotateInput);
  const id = (await params).id;
  if (getTokenRow(id)?.userId !== user.id) throw notFound("Key");
  const rotated = rotateToken(id, input.graceMinutes);
  if (!rotated) throw notFound("Key");
  return json(rotateResponse(rotated), 201);
});
