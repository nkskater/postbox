import { openThreadCounts } from "@/server/comments";
import { json, requireParam, route } from "@/server/http";

export const dynamic = "force-dynamic";

/** GET ?workspaceId= — unresolved thread counts keyed `<kind>:<id>`. */
export const GET = route((req: Request) => json(openThreadCounts(requireParam(req.url, "workspaceId"))));
