import { route, json, HttpError } from "@/server/http";
import { getTelemetryEndpoint } from "@/server/telemetry";
import { telemetryQueryFromUrl } from "@/server/telemetry-http";
export const GET = route(async (req: Request, ctx: { params: Promise<{ endpointId: string }> }) => {
  const ws = new URL(req.url).searchParams.get("workspaceId");
  if (!ws) throw new HttpError(400, "workspaceId required");
  return json(getTelemetryEndpoint(ws, (await ctx.params).endpointId, telemetryQueryFromUrl(req.url)));
});
