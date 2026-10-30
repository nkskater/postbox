/** DELETE /api/me/tokens/:id — revoke one of the caller's tokens. */
import { requireUser } from "@/server/caller";
import { json, notFound, route } from "@/server/http";
import { revokeToken } from "@/server/users";

type Ctx = { params: Promise<{ id: string }> };

export const DELETE = route(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  if (!revokeToken(requireUser(req).id, id)) throw notFound("Token");
  return json({ ok: true });
});
