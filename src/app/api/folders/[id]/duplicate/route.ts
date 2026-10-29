import * as repo from "@/server/repo";
import { json, notFound, route } from "@/server/http";

type Ctx = { params: Promise<{ id: string }> };

export const POST = route(async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  const copy = repo.duplicateFolder(id);
  if (!copy) throw notFound("Folder");
  return json(copy, 201);
});
