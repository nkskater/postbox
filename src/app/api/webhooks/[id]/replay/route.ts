import { z } from "zod";
import { replayDelivery } from "@/server/webhooks";
import { json, parseBody, route } from "@/server/http";

type Context = { params: Promise<{ id: string }> };

/** Queues a finished delivery again under a new delivery id (same event id). */
export const POST = route(async (req: Request, { params }: Context) => {
  const { deliveryId } = await parseBody(req, z.object({ deliveryId: z.string().min(1) }));
  return json(replayDelivery((await params).id, deliveryId), 202);
});
