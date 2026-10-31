/** POST /api/mqtt/[id]/unsubscribe — remove a topic subscription. */
import { z } from "zod";
import { json, parseBody, route } from "@/server/http";
import { mqttAction, requireMqttSession } from "@/server/mqtt-session";

export const POST = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const input = await parseBody(req, z.object({ topic: z.string().min(1).max(1024) }));
  const session = requireMqttSession((await params).id);
  await mqttAction(() => session.connection.unsubscribe(input.topic));
  return json({ ok: true });
});
