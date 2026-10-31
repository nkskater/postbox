import { datasetPatchSchema } from "@/core/runner/datasets";
import { getDataset, updateDataset, deleteDataset, datasetReferences } from "@/server/datasets";
import { json, parseBody, route } from "@/server/http";
import { datasetQuery } from "@/server/dataset-query";
type Context = { params: Promise<{ id: string }> };
export const GET = route(async (request: Request, { params }: Context) => {
  const id = (await params).id;
  return json({ ...getDataset(id, datasetQuery(request.url)), references: datasetReferences(id) });
});
export const PATCH = route(async (request: Request, { params }: Context) =>
  json(updateDataset((await params).id, await parseBody(request, datasetPatchSchema))),
);
export const DELETE = route(async (_request: Request, { params }: Context) =>
  json(deleteDataset((await params).id)),
);
