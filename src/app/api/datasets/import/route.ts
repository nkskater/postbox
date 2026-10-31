import { z } from "zod";
import { datasetImportSchema, importDataset } from "@/server/datasets";
import { json, parseBody, route } from "@/server/http";
export const POST = route(async (request: Request) => {
  const input = await parseBody(request, z.object({ workspaceId: z.string() }).and(datasetImportSchema));
  return json(importDataset(input.workspaceId, input), 201);
});
