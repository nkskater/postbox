import { route, json, HttpError } from "@/server/http";
import { getTelemetryMetrics } from "@/server/telemetry";
import { telemetryQueryFromUrl } from "@/server/telemetry-http";
export const GET = route((req: Request) => {
  const ws = new URL(req.url).searchParams.get("workspaceId");
  if (!ws) throw new HttpError(400, "workspaceId required");
  return json(getTelemetryMetrics(ws, telemetryQueryFromUrl(req.url)));
});
