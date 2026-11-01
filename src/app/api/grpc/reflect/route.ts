/**
 * POST /api/grpc/reflect — list the services and methods a running server exposes through
 * gRPC reflection. Takes the same request shape as POST /api/grpc (URL, headers, auth,
 * variables); the body and `settings.grpc` are ignored. Host policy applies.
 */
import { describeServices, ProtoError } from "@/core/grpc/proto";
import { reflectRoot } from "@/core/grpc/reflection";
import { redactStoredValue } from "@/core/variables/resolver";
import { getPolicy } from "@/server/context";
import { grpcRequestSchema, loadGrpcRequest } from "@/server/grpc-request";
import { HttpError, json, parseBody, route } from "@/server/http";

export const dynamic = "force-dynamic";

export const POST = route(async (req: Request) => {
  const input = await parseBody(req, grpcRequestSchema);
  let secrets: string[] = [];
  try {
    const { settings, prepared, secrets: all } = await loadGrpcRequest(input, req.signal);
    secrets = all;
    const root = await reflectRoot(
      {
        url: prepared.url,
        metadata: prepared.headers,
        verifySsl: settings.verifySsl,
        timeoutMs: settings.timeoutMs,
      },
      { policy: getPolicy(), signal: req.signal },
    );
    return json({ services: describeServices(root) });
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (err instanceof ProtoError || err instanceof Error)
      throw new HttpError(400, redactStoredValue(err.message, secrets));
    throw err;
  }
});
