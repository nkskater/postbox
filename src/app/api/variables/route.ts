import { z } from "zod";
import * as repo from "@/server/repo";
import { json, parseBody, requireParam, route } from "@/server/http";

export const dynamic = "force-dynamic";

const scopeSchema = z.enum(["global", "collection", "environment"]);

/** GET /api/variables?workspaceId=&scope=global|collection|environment&ownerId= */
export const GET = route((req: Request) => {
  const url = new URL(req.url);
  const workspaceId = requireParam(url, "workspaceId");
  const scope = scopeSchema.parse(url.searchParams.get("scope") ?? "global");
  return json(repo.listVariables(workspaceId, scope, url.searchParams.get("ownerId")));
});

/** PUT replaces the whole list for a scope/owner. */
export const PUT = route(async (req: Request) => {
  const input = await parseBody(
    req,
    z.object({
      workspaceId: z.string(),
      scope: scopeSchema,
      ownerId: z.string().nullish(),
      variables: z.array(
        z.object({
          key: z.string(),
          value: z.string().default(""),
          type: z.enum(["default", "secret"]).default("default"),
          enabled: z.boolean().default(true),
        }),
      ),
    }),
  );
  repo.replaceVariables(input.workspaceId, input.scope, input.ownerId ?? null, input.variables);
  return json(repo.listVariables(input.workspaceId, input.scope, input.ownerId ?? null));
});
