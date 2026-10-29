import * as repo from "@/server/repo";
import { json, notFound, route } from "@/server/http";

type Ctx = { params: Promise<{ id: string }> };

export const GET = route(async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  const h = repo.getHistory(id);
  if (!h) throw notFound("History entry");
  return json(h);
});
