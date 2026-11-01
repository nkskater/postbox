import { z } from "zod";
import { createWebhook, listWebhooks, webhookInput } from "@/server/webhooks";
import { json, parseBody, requireParam, route } from "@/server/http";

export const dynamic = "force-dynamic";

/** GET /api/webhooks?workspaceId= — configured webhooks (never their secrets). */
export const GET = route((req: Request) => json(listWebhooks(requireParam(req.url, "workspaceId"))));

/** POST creates a webhook; the response is the only one that contains the signing secret. */
export const POST = route(async (req: Request) => {
  const { workspaceId, ...input } = await parseBody(
    req,
    webhookInput.extend({ workspaceId: z.string().min(1) }),
  );
  return json(createWebhook(workspaceId, input), 201);
});
