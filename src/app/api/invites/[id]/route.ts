import { json, route } from "@/server/http";
import { revokeInvite } from "@/server/invites";
type Ctx = { params: Promise<{ id: string }> };
export const DELETE = route(async (_req: Request, { params }: Ctx) => {
  revokeInvite((await params).id);
  return json({ ok: true });
});
