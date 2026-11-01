import { sendTestEvent } from "@/server/webhooks";
import { json, route } from "@/server/http";

type Context = { params: Promise<{ id: string }> };

/** Queues a `webhook.test` event for this webhook only. */
export const POST = route(async (_req: Request, { params }: Context) =>
  json(sendTestEvent((await params).id), 202),
);
