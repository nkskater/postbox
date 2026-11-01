import { z } from "zod";
import { createListener, listListeners, listenerInput } from "@/server/hook-listeners";
import { json, parseBody, requireParam, route } from "@/server/http";

export const dynamic = "force-dynamic";

/** GET /api/hook-listeners?workspaceId= — configured listeners (never their tokens or secrets). */
export const GET = route((req: Request) => json(listListeners(requireParam(req.url, "workspaceId"))));

/** POST creates a listener; the response is the only one that contains its URL path. */
export const POST = route(async (req: Request) => {
  const { workspaceId, ...rest } = await parseBody(req, z.looseObject({ workspaceId: z.string().min(1) }));
  return json(createListener(workspaceId, listenerInput.parse(rest)), 201);
});
