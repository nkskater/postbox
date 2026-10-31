import { exportDataset } from "@/server/datasets";
import { datasetQuery } from "@/server/dataset-query";
import { json, route } from "@/server/http";
export const GET = route(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const data = exportDataset((await params).id, datasetQuery(request.url));
  return json(data, { headers: { "Content-Disposition": 'attachment; filename="dataset.postbox.json"' } });
});
