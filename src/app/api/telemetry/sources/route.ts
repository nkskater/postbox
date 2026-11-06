import { route, json, parseBody, HttpError } from "@/server/http";
import { createTelemetryInput, createTelemetrySource, listTelemetrySources } from "@/server/telemetry";
export const GET = route((req: Request) => {
  const id = new URL(req.url).searchParams.get("workspaceId");
  if (!id) throw new HttpError(400, "workspaceId required");
  return json(listTelemetrySources(id));
});
export const POST = route(async (req: Request) =>
  json(createTelemetrySource(await parseBody(req, createTelemetryInput)), 201),
);
