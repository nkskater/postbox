import { z } from "zod";
import * as repo from "@/server/repo";
import { json, parseBody, requireParam, route } from "@/server/http";

export const dynamic = "force-dynamic";

export const GET = route((req: Request) => {
  const workspaceId = requireParam(req.url, "workspaceId");
  return json(repo.listEnvironments(workspaceId));
});

export const POST = route(async (req: Request) => {
  const input = await parseBody(
    req,
    z.object({
      workspaceId: z.string(),
      name: z.string().min(1).max(200),
      variables: z.array(z.any()).optional(),
    }),
  );
  return json(repo.createEnvironment(input.workspaceId, input.name, input.variables ?? []), 201);
});
