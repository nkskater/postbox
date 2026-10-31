/** POST /api/socketio/[id]/close — disconnect a Socket.IO session. */
import { HttpError, json, route } from "@/server/http";
import { oauth2Owner } from "@/server/oauth2-owner";
import { getOwnedSession } from "@/server/ws-sessions";

export const POST = route(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const session = getOwnedSession(id, oauth2Owner(), "socketio");
  if (!session) throw new HttpError(404, "Socket.IO session not found");
  session.connection.close();
  return json({ ok: true });
});
