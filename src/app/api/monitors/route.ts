import { listMonitors, createMonitor, monitorInput } from "@/server/monitors";
import { json, parseBody, route, HttpError } from "@/server/http";
export const GET = route((req: Request) => {
  const id = new URL(req.url).searchParams.get("workspaceId");
  if (!id) throw new HttpError(400, "workspaceId required");
  return json(listMonitors(id));
});
export const POST = route(async (req: Request) =>
  json(createMonitor(await parseBody(req, monitorInput)), 201),
);
