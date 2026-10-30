import { z } from "zod";
import * as repo from "@/server/repo";
import { json, notFound, parseBody, route } from "@/server/http";
import { variableSchema } from "@/core/schemas";

type Ctx = { params: Promise<{ id: string }> };

export const GET = route(async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  const env = repo.getEnvironment(id);
  if (!env) throw notFound("Environment");
  return json(env);
});

export const PATCH = route(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const env = repo.getEnvironment(id);
  if (!env) throw notFound("Environment");
  const input = await parseBody(
    req,
    z.object({ name: z.string().min(1).max(200).optional(), variables: z.array(variableSchema).optional() }),
  );
  if (input.name) repo.renameEnvironment(id, input.name);
  if (input.variables) repo.replaceVariables(env.workspaceId, "environment", id, input.variables);
  return json(repo.getEnvironment(id));
});

export const DELETE = route(async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  repo.deleteEnvironment(id);
  return json({ ok: true });
});
