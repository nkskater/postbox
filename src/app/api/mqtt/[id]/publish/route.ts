/** POST /api/mqtt/[id]/publish — publish a text or base64 binary payload with QoS and retain. */
import { z } from "zod";
import { json, parseBody, route } from "@/server/http";
import { mqttAction, requireMqttSession } from "@/server/mqtt-session";

const qos = z.union([z.literal(0), z.literal(1), z.literal(2)]).default(0);

export const POST = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const input = await parseBody(
    req,
    z.object({
      topic: z.string().min(1).max(1024),
      payload: z
        .string()
        .max(2 * 1024 * 1024)
        .default(""),
      qos,
      retain: z.boolean().default(false),
      binary: z.boolean().default(false),
    }),
  );
  const session = requireMqttSession((await params).id);
  await mqttAction(() => session.connection.publish(input.topic, input.payload, input));
  return json({ ok: true });
});
