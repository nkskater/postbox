/**
 * GET /api/export/collection/:id[?includeSecrets=1&includeCredentials=1&format=v2.1|v3[&report=1]]
 * Postman v2.1 (default) or v3 export. `format=v3&report=1` returns `{ collection, diagnostics }` as JSON
 * so tools can show what v3 could not hold.
 */
import { exportPostmanCollection } from "@/core/convert/postman";
import { postmanV21ToV3 } from "@/core/convert/postman-v3";
import { HttpError } from "@/server/errors";
import * as repo from "@/server/repo";
import { json, notFound, route } from "@/server/http";

type Ctx = { params: Promise<{ id: string }> };

export const GET = route(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const folder = repo.getFolder(id);
  const tree = repo.getFolderTree(id);
  if (!folder || !tree) throw notFound("Collection");
  const includeSecrets = new URL(req.url).searchParams.get("includeSecrets") === "1";
  const includeCredentials = new URL(req.url).searchParams.get("includeCredentials") === "1";
  const vars = folder.parentId ? [] : repo.listVariables(folder.workspaceId, "collection", id);
  const query = new URL(req.url).searchParams;
  const format = query.get("format") ?? "v2.1";
  if (format !== "v2.1" && format !== "v3") throw new HttpError(400, 'format must be "v2.1" or "v3"');
  const v21 = exportPostmanCollection(tree, vars, { includeSecrets, includeCredentials });
  const v3 = format === "v3" ? postmanV21ToV3(v21) : null;
  if (v3 && query.get("report") === "1")
    return json({ collection: v3.collection, diagnostics: v3.diagnostics });
  const body = JSON.stringify(v3 ? v3.collection : v21, null, 2);
  const file = `${tree.name.replace(/[^\w.-]+/g, "_")}.postman_collection${v3 ? ".v3" : ""}.json`;
  return new Response(body, {
    headers: { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="${file}"` },
  });
});
