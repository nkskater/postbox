import * as repo from "@/server/repo";
import { json, route } from "@/server/http";

type Ctx = { params: Promise<{ id: string }> };

export const DELETE = route(async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  repo.deleteCookie(id);
  return json({ ok: true });
});
