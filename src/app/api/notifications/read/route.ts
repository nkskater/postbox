import { z } from "zod";
import { markNotificationsRead } from "@/server/comments";
import { json, parseBody, route } from "@/server/http";

export const dynamic = "force-dynamic";

/** POST { ids? } — mark notifications read; without ids, all of them. */
export const POST = route(async (req: Request) => {
  const { ids } = await parseBody(
    req,
    z.object({ ids: z.array(z.string().max(200)).max(200).optional() }).strict(),
  );
  return json(markNotificationsRead(ids));
});
