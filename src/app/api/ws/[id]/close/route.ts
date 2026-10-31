/** POST /api/ws/[id]/close — close an open session (normal closure unless a code is given). */
import { z } from "zod";
import { HttpError, json, parseBody, route } from "@/server/http";
import { oauth2Owner } from "@/server/oauth2-owner";
import { getOwnedSession } from "@/server/ws-sessions";

export const POST = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const input = await parseBody(
    req,
    z.object({
      code: z.number().int().min(1000).max(4999).default(1000),
      reason: z.string().max(123).default(""),
    }),
  );
  const session = getOwnedSession(id, oauth2Owner());
  if (!session) throw new HttpError(404, "WebSocket session not found");
  session.connection.close(input.code === 1000 || input.code >= 3000 ? input.code : 1000, input.reason);
  return json({ ok: true });
});
