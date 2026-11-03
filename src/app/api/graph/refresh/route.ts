import { z } from "zod";
import { refreshGraph } from "@/server/graph";
import { json, parseBody, route } from "@/server/http";

export const dynamic = "force-dynamic";

/** POST { workspaceId } — re-index changed sources and drop the ones that no longer exist. */
export const POST = route(async (req: Request) => {
  const { workspaceId } = await parseBody(req, z.object({ workspaceId: z.string().min(1) }));
  return json(refreshGraph(workspaceId));
});
