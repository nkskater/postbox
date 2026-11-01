/** POST /api/grpc/[id]/cancel — cancel the call; the stream reports a CANCELLED status. */
import { grpcAction, requireGrpcSession } from "@/server/grpc-session";
import { json, route } from "@/server/http";

export const POST = route(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const session = requireGrpcSession((await params).id);
  grpcAction(() => session.connection.cancel());
  return json({ ok: true });
});
