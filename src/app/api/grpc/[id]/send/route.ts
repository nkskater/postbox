/** POST /api/grpc/[id]/send — send one JSON message on an open interactive call. */
import { z } from "zod";
import { grpcAction, requireGrpcSession } from "@/server/grpc-session";
import { json, parseBody, route } from "@/server/http";

export const POST = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const input = await parseBody(req, z.object({ message: z.unknown() }));
  const session = requireGrpcSession((await params).id);
  grpcAction(() => session.connection.send(input.message));
  return json({ ok: true });
});
