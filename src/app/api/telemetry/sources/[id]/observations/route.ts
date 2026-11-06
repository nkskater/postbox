import { route, json } from "@/server/http";
import { purgeTelemetrySource } from "@/server/telemetry";
export const DELETE = route(async (_req: Request, ctx: { params: Promise<{ id: string }> }) =>
  json(purgeTelemetrySource((await ctx.params).id)),
);
