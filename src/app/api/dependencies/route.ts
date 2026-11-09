import { installInput, installRelease, listInstalls } from "@/server/dependencies";
import { json, parseBody, requireParam, route } from "@/server/http";

export const dynamic = "force-dynamic";

/** GET ?workspaceId= — collections installed from shared releases, with update and edit status. */
export const GET = route((req: Request) => json(listInstalls(requireParam(req.url, "workspaceId"))));

/** POST { workspaceId, releaseId } — install a release as a new collection pinned to that version. */
export const POST = route(async (req: Request) =>
  json(installRelease(await parseBody(req, installInput)), 201),
);
