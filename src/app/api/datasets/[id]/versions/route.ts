import { datasetRevisionSchema } from "@/core/runner/datasets";
import { createDatasetVersion, listDatasetVersions } from "@/server/datasets";
import { json, parseBody, route } from "@/server/http";
type Context = { params: Promise<{ id: string }> };
export const GET = route(async (_request: Request, { params }: Context) =>
  json(listDatasetVersions((await params).id)),
);
export const POST = route(async (request: Request, { params }: Context) =>
  json(createDatasetVersion((await params).id, await parseBody(request, datasetRevisionSchema)), 201),
);
