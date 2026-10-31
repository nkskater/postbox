/** POST /api/mqtt/[id]/subscribe — subscribe to a topic filter with a QoS. */
import { z } from "zod";
import { json, parseBody, route } from "@/server/http";
import { mqttAction, requireMqttSession } from "@/server/mqtt-session";

export const POST = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const input = await parseBody(
    req,
    z.object({
      topic: z.string().min(1).max(1024),
      qos: z.union([z.literal(0), z.literal(1), z.literal(2)]).default(0),
    }),
  );
  const session = requireMqttSession((await params).id);
  await mqttAction(() => session.connection.subscribe(input.topic, input.qos));
  return json({ ok: true });
});
