import { z } from "zod";
import { retryMonitorEmail } from "@/server/monitors";
import { json, parseBody, route } from "@/server/http";
export const POST = route(async (req: Request, c: { params: Promise<{ id: string }> }) =>
  json(
    retryMonitorEmail(
      (await c.params).id,
      (await parseBody(req, z.object({ deliveryId: z.string().min(1) }))).deliveryId,
    ),
  ),
);
