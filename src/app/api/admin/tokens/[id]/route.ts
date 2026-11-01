/** DELETE /api/admin/tokens/:id — revoke any key, whoever owns it. Administrators only. */
import { json, notFound, route } from "@/server/http";
import { getTokenRow, revokeToken } from "@/server/users";

export const dynamic = "force-dynamic";

export const DELETE = route(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const key = getTokenRow((await params).id);
  if (!key || !revokeToken(key.userId, key.id)) throw notFound("Key");
  return json({ ok: true });
});
