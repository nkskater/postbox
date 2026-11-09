import { route, json, parseBody } from "@/server/http";
import { grantGatewayProvider, gatewayGrantInput } from "@/server/gateway";
export const POST = route(async (req: Request, ctx: { params: Promise<{ id: string }> }) =>
  json(grantGatewayProvider((await ctx.params).id, await parseBody(req, gatewayGrantInput)), 201),
);
