import { z } from "zod";
import { listSources, setSourceConnected } from "@/server/graph";
import { json, parseBody, requireParam, route } from "@/server/http";
import { graphConnectSchema } from "@/core/graph/model";

export const dynamic = "force-dynamic";

/** GET /api/graph/sources?workspaceId= — what was indexed, and whether each source is fresh, stale or revoked. */
export const GET = route((req: Request) =>
  json({ sources: listSources(requireParam(req.url, "workspaceId")) }),
);

/** PATCH { workspaceId, sourceId, connected } — connect or disconnect a telemetry source. */
export const PATCH = route(async (req: Request) => {
  const body = await parseBody(
    req,
    graphConnectSchema.extend({ workspaceId: z.string().min(1), sourceId: z.string().min(1).max(200) }),
  );
  return json(setSourceConnected(body.workspaceId, body.sourceId, body.connected));
});
