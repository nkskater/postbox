/** GET /api/export/collection/:id[?includeSecrets=1] — Postman v2.1 export. */
import { exportPostmanCollection } from "@/core/convert/postman";
import * as repo from "@/server/repo";
import { notFound, route } from "@/server/http";

type Ctx = { params: Promise<{ id: string }> };

export const GET = route(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const folder = repo.getFolder(id);
  const tree = repo.getFolderTree(id);
  if (!folder || !tree) throw notFound("Collection");
  const includeSecrets = new URL(req.url).searchParams.get("includeSecrets") === "1";
  const vars = folder.parentId ? [] : repo.listVariables(folder.workspaceId, "collection", id);
  const body = JSON.stringify(exportPostmanCollection(tree, vars, { includeSecrets }), null, 2);
  const file = `${tree.name.replace(/[^\w.-]+/g, "_")}.postman_collection.json`;
  return new Response(body, {
    headers: { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="${file}"` },
  });
});
