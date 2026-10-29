/** GET /api/export/environment/:id[?includeSecrets=1] — Postman environment export ("globals" for globals). */
import { exportPostmanEnvironment } from "@/core/convert/postman";
import * as repo from "@/server/repo";
import { HttpError, notFound, route } from "@/server/http";

type Ctx = { params: Promise<{ id: string }> };

export const GET = route(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const url = new URL(req.url);
  const includeSecrets = url.searchParams.get("includeSecrets") === "1";
  let name: string;
  let data;
  if (id === "globals") {
    const workspaceId = url.searchParams.get("workspaceId");
    if (!workspaceId) throw new HttpError(400, "workspaceId is required for globals");
    name = "Globals";
    data = {
      ...exportPostmanEnvironment(name, repo.listVariables(workspaceId, "global", null), { includeSecrets }),
      _postman_variable_scope: "globals",
    };
  } else {
    const env = repo.getEnvironment(id);
    if (!env) throw notFound("Environment");
    name = env.name;
    data = exportPostmanEnvironment(env.name, env.variables, { includeSecrets });
  }
  const file = `${name.replace(/[^\w.-]+/g, "_")}.postman_environment.json`;
  return new Response(JSON.stringify(data, null, 2), {
    headers: { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="${file}"` },
  });
});
