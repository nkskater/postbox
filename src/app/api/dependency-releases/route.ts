import { browseReleases } from "@/server/dependencies";
import { json, requireParam, route } from "@/server/http";

export const dynamic = "force-dynamic";

/** GET ?workspaceId= — released collections from other workspaces that the caller may install. */
export const GET = route((req: Request) => json(browseReleases(requireParam(req.url, "workspaceId"))));
