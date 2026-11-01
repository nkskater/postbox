/**
 * POST /api/grpc — call a gRPC method (unary or streaming) using the .proto sources in the
 * request's settings, or the server's reflection service when `settings.grpc.reflection` is
 * set. The body holds the message JSON (an array for client and bidirectional streaming).
 * Host policy applies; events stream back as NDJSON. The target is checked before anything
 * is sent, so setup problems return HTTP 400.
 */
import { z } from "zod";
import { startGrpcCall } from "@/core/grpc/client";
import { loadProtoRoot, ProtoError, resolveMethod } from "@/core/grpc/proto";
import { reflectRoot } from "@/core/grpc/reflection";
import { redactStoredValue } from "@/core/variables/resolver";
import { createEventStream } from "@/server/event-stream";
import { getPolicy } from "@/server/context";
import { definitionFiles } from "@/server/grpc-definitions";
import { grpcRequestSchema, loadGrpcRequest } from "@/server/grpc-request";
import { HttpError, parseBody, route } from "@/server/http";
import { oauth2Owner } from "@/server/oauth2-owner";
import {
  MAX_SESSIONS,
  registerSession,
  removeSession,
  sessionCount,
  touchSession,
} from "@/server/ws-sessions";

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

const schema = grpcRequestSchema.extend({
  /**
   * Keep the request stream open; send, end and cancel through /api/grpc/{id}/... "auto" does
   * so only for methods that stream from the client.
   */
  interactive: z.union([z.boolean(), z.literal("auto")]).optional(),
});

export const POST = route(async (req: Request) => {
  const input = await parseBody(req, schema);
  const events = createEventStream();
  let sessionId = "";
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
      : loadProtoRoot(
          grpcSettings.definitionId
            ? definitionFiles(input.workspaceId, grpcSettings.definitionId)
            : grpcSettings.protos,
        );
    const { info } = resolveMethod(root, grpcSettings.service, grpcSettings.method);
    const messages = parseMessages(resolvedBody.mode === "raw" ? resolvedBody.raw : "", info.clientStreaming);
    const interactive = input.interactive === "auto" ? info.clientStreaming : !!input.interactive;
    if (interactive && sessionCount() >= MAX_SESSIONS) throw new HttpError(429, "Too many open connections");

    const { connection } = await startGrpcCall(
      {
        url: prepared.url,
        root,
        service: grpcSettings.service,
        method: grpcSettings.method,
        messages,
        metadata: prepared.headers,
        verifySsl: settings.verifySsl,
        timeoutMs: settings.timeoutMs,
        interactive,
      },
      (e) => {
        events.send(redactStoredValue(e, secrets));
        if (e.type === "done") {
          if (sessionId) removeSession(sessionId);
          events.close();
        }
      },
      { policy: getPolicy(), signal: req.signal },
    );
    if (interactive) {
      const session = registerSession(oauth2Owner(), input.workspaceId, { kind: "grpc", connection });
      sessionId = session.id;
      touchSession(session);
      events.send({ type: "session", id: session.id });
    }
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
