import { z } from "zod";
import { replayEvent } from "@/server/hook-listeners";
import { json, parseBody, route } from "@/server/http";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

/** POST sends one stored event to the forward URL (or `url`). Nothing is ever replayed automatically. */
export const POST = route(async (req: Request, { params }: Context) => {
  const { eventId, url } = await parseBody(
    req,
    z.object({ eventId: z.string().min(1), url: z.string().max(2000).nullish() }),
  );
  return json(await replayEvent((await params).id, eventId, url));
});
