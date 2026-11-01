import { rotateWebhookSecret } from "@/server/webhooks";
import { json, route } from "@/server/http";

type Context = { params: Promise<{ id: string }> };

/** Issues a new signing secret and returns it once. */
export const POST = route(async (_req: Request, { params }: Context) =>
  json(rotateWebhookSecret((await params).id)),
);
