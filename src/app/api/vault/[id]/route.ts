/**
 * GET    /api/vault/:id — metadata only.
 * PATCH  /api/vault/:id { name?, value?, description?, scriptAccess?, collectionIds? } — a new `value` replaces the old
 *        one (rotation); a new `name` re-encrypts it. References by the old name stop resolving.
 * DELETE /api/vault/:id
 */
import { json, parseBody, route } from "@/server/http";
import { deleteSecret, getSecret, secretPatch, updateSecret } from "@/server/vault";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export const GET = route(async (_req: Request, { params }: Ctx) => json(getSecret((await params).id)));
export const PATCH = route(async (req: Request, { params }: Ctx) =>
  json(updateSecret((await params).id, await parseBody(req, secretPatch))),
);
export const DELETE = route(async (_req: Request, { params }: Ctx) => {
  deleteSecret((await params).id);
  return json({ deleted: true });
});
