import * as repo from "@/server/repo";
import { json, notFound, route } from "@/server/http";

type Ctx = { params: Promise<{ id: string }> };

export const POST = route(async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  const env = repo.getEnvironment(id);
  if (!env) throw notFound("Environment");
  return json(repo.createEnvironment(env.workspaceId, `${env.name} Copy`, env.variables), 201);
});
