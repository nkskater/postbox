/** DELETE /api/admin/usage/limits/:id — remove a quota. Administrators only. */
import { json, notFound, route } from "@/server/http";
import { deleteLimit } from "@/server/usage";

export const dynamic = "force-dynamic";

export const DELETE = route(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  if (!deleteLimit((await params).id)) throw notFound("Limit");
  return json({ ok: true });
});
