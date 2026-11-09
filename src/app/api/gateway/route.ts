import { route, json, requireParam } from "@/server/http";
import { gatewaySnapshot } from "@/server/gateway";
export const GET = route((req: Request) => json(gatewaySnapshot(requireParam(req.url, "workspaceId"))));
