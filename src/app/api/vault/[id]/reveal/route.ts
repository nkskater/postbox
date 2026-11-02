/**
 * POST /api/vault/:id/reveal — the secret's value, for its creator or a workspace owner (the owner of a personal secret).
 * Every reveal is recorded in the audit log, without the value. Nothing else ever returns a value.
 */
import { json, route } from "@/server/http";
import { revealSecret } from "@/server/vault";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export const POST = route(async (_req: Request, { params }: Ctx) => {
  const res = json(revealSecret((await params).id));
  res.headers.set("Cache-Control", "no-store");
  return res;
});
