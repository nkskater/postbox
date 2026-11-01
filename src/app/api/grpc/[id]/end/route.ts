/** POST /api/grpc/[id]/end — half-close the request stream; the call continues until the server finishes. */
import { grpcAction, requireGrpcSession } from "@/server/grpc-session";
import { json, route } from "@/server/http";

export const POST = route(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const session = requireGrpcSession((await params).id);
  grpcAction(() => session.connection.end());
  return json({ ok: true });
});
