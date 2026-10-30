import { z } from "zod";
import * as repo from "@/server/repo";
import { HttpError, json, notFound, parseBody, route } from "@/server/http";
import { authSchema, keyValueSchema, variableSchema } from "@/core/schemas";

type Ctx = { params: Promise<{ id: string }> };

export const GET = route(async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  const f = repo.getFolder(id);
  if (!f) throw notFound("Folder");
  const variables = f.parentId ? [] : repo.listVariables(f.workspaceId, "collection", f.id);
  return json({ ...f, variables });
});

const patchSchema = z.object({
  parentId: z.string().min(1).nullable().optional(),
  name: z.string().min(1).max(300).optional(),
  description: z.string().optional(),
  auth: authSchema.optional(),
  headers: z.array(keyValueSchema).optional(),
  preRequestScript: z.string().optional(),
  testScript: z.string().optional(),
  variables: z.array(variableSchema).optional(),
});

export const PATCH = route(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const f = repo.getFolder(id);
  if (!f) throw notFound("Folder");
  const { variables, parentId, ...patch } = await parseBody(req, patchSchema);
  if (parentId !== undefined && parentId !== f.parentId) {
    const parent = parentId ? repo.getFolder(parentId) : null;
    if (parentId && (!parent || parent.workspaceId !== f.workspaceId))
      throw new HttpError(400, "Parent must belong to the same workspace");
    try {
      repo.reorder("folder", id, parentId, Number.MAX_SAFE_INTEGER);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, (error as Error).message);
    }
  }
  repo.updateFolder(id, patch);
  if (variables && !f.parentId) repo.replaceVariables(f.workspaceId, "collection", id, variables);
  return json(repo.getFolder(id));
});

export const DELETE = route(async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  repo.deleteFolder(id);
  return json({ ok: true });
});
