import { route, json, parseBody } from "@/server/http";
import { createGatewayProvider, gatewayProviderInput } from "@/server/gateway";
export const POST = route(async (req: Request) =>
  json(createGatewayProvider(await parseBody(req, gatewayProviderInput)), 201),
);
