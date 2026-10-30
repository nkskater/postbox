import { json, route } from "@/server/http";
import { revokeUserAccess } from "@/server/users";
type Ctx = { params: Promise<{ id: string }> };
export const POST = route(async (_req: Request, { params }: Ctx) => {
  revokeUserAccess((await params).id);
  return json({ ok: true });
});
