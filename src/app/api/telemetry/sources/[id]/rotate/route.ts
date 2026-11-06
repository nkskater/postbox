import { route, json, parseBody } from "@/server/http";
import { rotateTelemetrySource, rotateTelemetryInput } from "@/server/telemetry";
export const POST = route(async (req: Request, ctx: { params: Promise<{ id: string }> }) =>
  json(rotateTelemetrySource((await ctx.params).id, await parseBody(req, rotateTelemetryInput))),
);
