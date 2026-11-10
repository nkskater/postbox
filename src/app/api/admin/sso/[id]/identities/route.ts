import { z } from "zod";
import { json, route, parseBody } from "@/server/http";
import { mapIdentity } from "@/server/sso";
export const POST = route(async (req: Request, context: { params: Promise<{ id: string }> }) => {
  const body = await parseBody(
    req,
    z.object({ subject: z.string().min(1).max(2048), userId: z.string().min(1) }).strict(),
  );
  mapIdentity((await context.params).id, body.subject, body.userId);
  return json({ ok: true }, 201);
});
