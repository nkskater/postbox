/** POST /api/mqtt/[id]/close — disconnect from the broker. */
import { json, route } from "@/server/http";
import { requireMqttSession } from "@/server/mqtt-session";

export const POST = route(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  requireMqttSession((await params).id).connection.close();
  return json({ ok: true });
});
