import { graphOverview } from "@/server/graph";
import { json, requireParam, route } from "@/server/http";

export const dynamic = "force-dynamic";

/** GET /api/graph?workspaceId= — node and edge counts and the state of every source. */
export const GET = route((req: Request) => json(graphOverview(requireParam(req.url, "workspaceId"))));
