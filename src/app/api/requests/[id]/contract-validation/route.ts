import { contractReport } from "@/core/contracts/report";
import { getRequest } from "@/server/repo";
import { json, notFound, route } from "@/server/http";
export const GET = route(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const request = getRequest((await params).id);
  if (!request) throw notFound("Request");
  return json(contractReport(request));
});
