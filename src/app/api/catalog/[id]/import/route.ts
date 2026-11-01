import { catalogImportSchema } from "@/core/catalog/model";
import { importCatalog } from "@/server/catalog";
import { json, parseBody, route } from "@/server/http";
export const POST = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const input = await parseBody(req, catalogImportSchema);
  return json(importCatalog((await params).id, input.workspaceId, input.version), 201);
});
