import { z } from "zod";
import * as repo from "@/server/repo";
import { json, notFound, parseBody, route } from "@/server/http";

type Ctx = { params: Promise<{ id: string }> };

export const GET = route(async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  const f = repo.getFolder(id);
  if (!f) throw notFound("Folder");
  const variables = f.parentId ? [] : repo.listVariables(f.workspaceId, "collection", f.id);
  return json({ ...f, variables });
});

const patchSchema = z.object({
  name: z.string().min(1).max(300).optional(),
  description: z.string().optional(),
  auth: z.any().optional(),
  headers: z.array(z.any()).optional(),
  preRequestScript: z.string().optional(),
  testScript: z.string().optional(),
  variables: z.array(z.any()).optional(),
});

export const PATCH = route(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const f = repo.getFolder(id);
  if (!f) throw notFound("Folder");
  const { variables, ...patch } = await parseBody(req, patchSchema);
  repo.updateFolder(id, patch);
  if (variables && !f.parentId) repo.replaceVariables(f.workspaceId, "collection", id, variables);
  return json(repo.getFolder(id));
});

export const DELETE = route(async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  repo.deleteFolder(id);
  return json({ ok: true });
});
