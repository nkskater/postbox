/** POST /api/socketio/[id]/emit — emit a named event with JSON arguments, optionally awaiting an ack. */
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
    z.object({
      event: z.string().min(1).max(256),
      args: z.array(z.unknown()).max(20).default([]),
      ack: z.boolean().default(false),
    }),
  );
  const session = getOwnedSession(id, oauth2Owner(), "socketio");
  if (!session) throw new HttpError(404, "Socket.IO session not found");
  authorize(currentCaller(), session.workspaceId, "run");
  try {
    session.connection.emit(input.event, input.args, input.ack);
  } catch (err) {
    throw new HttpError(409, (err as Error).message);
  }
  touchSession(session);
  return json({ ok: true });
});
