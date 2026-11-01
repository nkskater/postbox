/**
 * POST /api/grpc — call a gRPC method (unary or streaming) using the .proto sources in the
 * request's settings, or the server's reflection service when `settings.grpc.reflection` is
 * set. The body holds the message JSON (an array for client and bidirectional streaming).
 * Host policy applies; events stream back as NDJSON. The target is checked before anything
 * is sent, so setup problems return HTTP 400.
 */
import { startGrpcCall } from "@/core/grpc/client";
import { loadProtoRoot, ProtoError, resolveMethod } from "@/core/grpc/proto";
import { reflectRoot } from "@/core/grpc/reflection";
import { redactStoredValue } from "@/core/variables/resolver";
import { createEventStream } from "@/server/event-stream";
import { getPolicy } from "@/server/context";
import { grpcRequestSchema, loadGrpcRequest } from "@/server/grpc-request";
import { HttpError, parseBody, route } from "@/server/http";

export const dynamic = "force-dynamic";

/** Body JSON -> messages: an array for client-streaming methods, one object otherwise. */
function parseMessages(raw: string, clientStreaming: boolean): unknown[] {
  const text = raw.trim();
  if (!text) return clientStreaming ? [] : [{}];
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ProtoError("The request body must be valid JSON");
  }
  if (clientStreaming) return Array.isArray(value) ? value : [value];
  if (Array.isArray(value)) throw new ProtoError("This method takes a single message; send one JSON object");
  return [value];
}

export const POST = route(async (req: Request) => {
  const input = await parseBody(req, grpcRequestSchema);
  const events = createEventStream();
  let secrets: string[] = [];
  try {
    const { settings, prepared, resolvedBody, secrets: all } = await loadGrpcRequest(input, req.signal);
    secrets = all;
    const grpcSettings = settings.grpc;
    if (!grpcSettings) throw new HttpError(400, "Add .proto definitions or enable reflection first");
    if (resolvedBody.mode !== "raw" && resolvedBody.mode !== "none")
      throw new ProtoError("gRPC bodies must be raw JSON");

    const root = grpcSettings.reflection
      ? await reflectRoot(
          {
            url: prepared.url,
            metadata: prepared.headers,
            verifySsl: settings.verifySsl,
            timeoutMs: settings.timeoutMs,
          },
          { policy: getPolicy(), signal: req.signal },
        )
      : loadProtoRoot(grpcSettings.protos);
    const { info } = resolveMethod(root, grpcSettings.service, grpcSettings.method);
    const messages = parseMessages(resolvedBody.mode === "raw" ? resolvedBody.raw : "", info.clientStreaming);

    await startGrpcCall(
      {
        url: prepared.url,
        root,
        service: grpcSettings.service,
        method: grpcSettings.method,
        messages,
        metadata: prepared.headers,
        verifySsl: settings.verifySsl,
        timeoutMs: settings.timeoutMs,
      },
      (e) => {
        events.send(redactStoredValue(e, secrets));
        if (e.type === "done") events.close();
      },
      { policy: getPolicy(), signal: req.signal },
    );
  } catch (err) {
    events.close();
    if (err instanceof HttpError) throw err;
    // Definition, message and host-policy problems are the caller's to fix.
    throw new HttpError(400, redactStoredValue((err as Error).message, secrets));
  }
  return new Response(events.stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
});
