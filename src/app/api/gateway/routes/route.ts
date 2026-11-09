import { route, json, parseBody } from "@/server/http";
import { createGatewayRoute, createGatewayRouteInput } from "@/server/gateway";
export const POST = route(async (req: Request) =>
  json(createGatewayRoute(await parseBody(req, createGatewayRouteInput)), 201),
);
