/** POST /api/ws/[id]/send — send a text or base64 binary frame on an open session. */
import { z } from "zod";
import { authorize } from "@/server/authorize";
import { currentCaller } from "@/server/access-context";
import { HttpError, json, parseBody, route } from "@/server/http";
import { oauth2Owner } from "@/server/oauth2-owner";
import { getOwnedSession, touchSession } from "@/server/ws-sessions";

export const POST = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const input = await parseBody(
    req,
    z.object({ data: z.string().max(2 * 1024 * 1024), binary: z.boolean().default(false) }),
  );
  const session = getOwnedSession(id, oauth2Owner(), "ws");
  if (!session) throw new HttpError(404, "WebSocket session not found");
  authorize(currentCaller(), session.workspaceId, "run");
  try {
    session.connection.send(input.data, input.binary);
  } catch (err) {
    throw new HttpError(409, (err as Error).message);
  }
  touchSession(session);
  return json({ ok: true });
});
