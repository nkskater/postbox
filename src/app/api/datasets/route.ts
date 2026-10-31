import { z } from "zod";
import { datasetCreateSchema } from "@/core/runner/datasets";
import { createDataset, listDatasets } from "@/server/datasets";
import { json, parseBody, requireParam, route } from "@/server/http";
export const GET = route((request: Request) => json(listDatasets(requireParam(request.url, "workspaceId"))));
export const POST = route(async (request: Request) => {
  const input = await parseBody(request, z.object({ workspaceId: z.string() }).and(datasetCreateSchema));
  return json(createDataset(input.workspaceId, input), 201);
});
