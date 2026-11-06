import { route, json, parseBody } from "@/server/http";
import {
  getTelemetrySource,
  saveTelemetrySource,
  saveTelemetryInput,
  deleteTelemetrySource,
} from "@/server/telemetry";
type Context = { params: Promise<{ id: string }> };
export const GET = route(async (_req: Request, ctx: Context) =>
  json(getTelemetrySource((await ctx.params).id)),
);
export const PATCH = route(async (req: Request, ctx: Context) =>
  json(saveTelemetrySource((await ctx.params).id, await parseBody(req, saveTelemetryInput))),
);
export const DELETE = route(async (_req: Request, ctx: Context) =>
  json(deleteTelemetrySource((await ctx.params).id)),
);
