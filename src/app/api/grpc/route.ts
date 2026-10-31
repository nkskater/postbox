/**
 * POST /api/grpc — call a gRPC method (unary or streaming) using the .proto sources and
 * method stored in the request's settings. The body holds the message JSON (an array for
 * client and bidirectional streaming). Host policy applies; events stream back as NDJSON.
 * The target is checked before anything is sent, so setup problems return HTTP 400.
 */
import { z } from "zod";
import type { FolderDef } from "@/core/types";
import { DEFAULT_SETTINGS } from "@/core/types";
import { requestInputSchema } from "@/core/schemas";
import { startGrpcCall } from "@/core/grpc/client";
import { loadProtoRoot, ProtoError, resolveMethod } from "@/core/grpc/proto";
import { prepareRequest } from "@/core/http/prepare";
import { Resolver, redactStoredValue } from "@/core/variables/resolver";
import { authCredentialValues, credentialRedactionValues } from "@/core/retention";
import { createEventStream } from "@/server/event-stream";
import { getPolicy, loadScopes } from "@/server/context";
import { defaultRequest } from "@/server/defaults";
import { HttpError, parseBody, route } from "@/server/http";
import * as repo from "@/server/repo";

export const dynamic = "force-dynamic";

const schema = z.object({
  workspaceId: z.string().min(1),
  environmentId: z.string().nullish(),
  folderId: z.string().nullish(),
  request: requestInputSchema,
});

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
  const input = await parseBody(req, schema);
  if (input.folderId) repo.requireFolderIn(input.workspaceId, input.folderId);
  if (input.environmentId) repo.requireEnvironmentIn(input.workspaceId, input.environmentId);
  const chain: FolderDef[] = input.folderId ? repo.getFolderChain(input.folderId) : [];
  const ctx = loadScopes(input.workspaceId, input.environmentId ?? null, chain[0]?.id ?? null);
  const resolver = new Resolver(ctx.scopes);
  const r = input.request;
  const settings = { ...DEFAULT_SETTINGS, ...(r.settings ?? {}) };
  if (!settings.grpc) throw new HttpError(400, "Add .proto definitions and select a method first");
  const grpcSettings = settings.grpc;

  const events = createEventStream();
  try {
    const request = defaultRequest({ ...r, method: "POST", settings });
    const { prepared, effectiveAuth, resolvedBody } = await prepareRequest(request, chain, resolver, {
      policy: getPolicy(),
      signal: req.signal,
    });
    if (prepared.digest || prepared.ntlm || prepared.awsv4)
      throw new ProtoError("This authentication type cannot be used for gRPC");
    if (resolvedBody.mode !== "raw" && resolvedBody.mode !== "none")
      throw new ProtoError("gRPC bodies must be raw JSON");
    const secrets = credentialRedactionValues([...ctx.secrets, ...authCredentialValues(effectiveAuth)]);

    const root = loadProtoRoot(grpcSettings.protos);
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
    throw new HttpError(400, redactStoredValue((err as Error).message, ctx.secrets));
  }
  return new Response(events.stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
});
