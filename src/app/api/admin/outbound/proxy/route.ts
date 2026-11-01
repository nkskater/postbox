/**
 * GET    /api/admin/outbound/proxy — the saved proxy (the password is never returned, only whether one is set).
 * PUT    /api/admin/outbound/proxy { url, enabled?, username?, password?, bypass? } — save it. Omit `password`
 *        to keep the stored one; send an empty string to remove it.
 * DELETE /api/admin/outbound/proxy — remove the proxy.
 * Administrators only. The proxy applies to every outbound HTTP(S), SSE, WebSocket and Socket.IO connection.
 */
import { z } from "zod";
import { json, parseBody, route } from "@/server/http";
import { clearProxy, getProxy, setProxy } from "@/server/outbound";

export const dynamic = "force-dynamic";

export const GET = route(() => json(getProxy()));

export const PUT = route(async (req: Request) =>
  json(
    setProxy(
      await parseBody(
        req,
        z
          .object({
            url: z.string().min(1).max(2048),
            enabled: z.boolean().optional(),
            username: z.string().max(256).optional(),
            password: z.string().max(1024).optional(),
            bypass: z.array(z.string().max(253)).max(200).optional(),
          })
          .strict(),
      ),
    ),
  ),
);

export const DELETE = route(() => json({ removed: clearProxy() }));
