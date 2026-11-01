import { deleteWebhook, getWebhook, updateWebhook, webhookPatch } from "@/server/webhooks";
import { json, parseBody, route } from "@/server/http";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

export const GET = route(async (_req: Request, { params }: Context) => json(getWebhook((await params).id)));
export const PATCH = route(async (req: Request, { params }: Context) =>
  json(updateWebhook((await params).id, await parseBody(req, webhookPatch))),
);
export const DELETE = route(async (_req: Request, { params }: Context) => {
  deleteWebhook((await params).id);
  return json({ ok: true });
});
