import { route, json, parseBody } from "@/server/http";
import { getGatewayRoute, updateGatewayRoute, deleteGatewayRoute } from "@/server/gateway";
import { gatewayRouteInput } from "@/core/gateway/model";
type Context = { params: Promise<{ id: string }> };
export const GET = route(async (_req: Request, ctx: Context) => json(getGatewayRoute((await ctx.params).id)));
export const PUT = route(async (req: Request, ctx: Context) =>
  json(updateGatewayRoute((await ctx.params).id, await parseBody(req, gatewayRouteInput))),
);
export const DELETE = route(async (_req: Request, ctx: Context) =>
  json(deleteGatewayRoute((await ctx.params).id)),
);
