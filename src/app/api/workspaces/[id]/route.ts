import { z } from "zod";
import * as repo from "@/server/repo";
import { json, notFound, parseBody, route } from "@/server/http";

type Ctx = { params: Promise<{ id: string }> };

export const PATCH = route(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  if (!repo.getWorkspace(id)) throw notFound("Workspace");
  const { name } = await parseBody(req, z.object({ name: z.string().min(1).max(200) }));
  repo.renameWorkspace(id, name);
  return json(repo.getWorkspace(id));
});

export const DELETE = route(async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  repo.deleteWorkspace(id);
  return json({ ok: true });
});
