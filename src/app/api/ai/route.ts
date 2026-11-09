/**
 * POST /api/ai — send a model request (variables, auth, inherited headers and policy applied; scripts
 * are not run) and relay it as NDJSON: `open`, then normalised `text` / `reasoning` / `tool_call` /
 * `usage` / `finish` events as the provider produces them, then `done` with the assembled result.
 *
 * Tool calls are only reported. Nothing here ever runs a tool: the person sends a tool result back
 * as a message in the next request.
 */
import { z } from "zod";
import { buildAiPayload, providerHeaders } from "@/core/ai/build";
import { AiAccumulator, createDecoder, errorMessage, parseResponse } from "@/core/ai/parse";
import type { AiEvent, AiResult } from "@/core/ai/types";
import { sendRequest } from "@/core/http/engine";
import { prepareRequest } from "@/core/http/prepare";
import { streamEvents } from "@/core/http/sse";
import { authCredentialValues, credentialRedactionValues } from "@/core/retention";
import { requestInputSchema } from "@/core/schemas";
import { DEFAULT_SETTINGS, type FolderDef } from "@/core/types";
import { Resolver, emptyScopes, redactStoredValue } from "@/core/variables/resolver";
import { getPolicy, loadScopes } from "@/server/context";
import { defaultRequest } from "@/server/defaults";
import { HttpError } from "@/server/errors";
import { createEventStream } from "@/server/event-stream";
import { executionSettings } from "@/server/execution-settings";
import { parseBody, route } from "@/server/http";
import * as repo from "@/server/repo";

export const dynamic = "force-dynamic";

const schema = z.object({
  workspaceId: z.string().min(1),
  environmentId: z.string().nullish(),
  folderId: z.string().nullish(),
  request: requestInputSchema,
  assistant: z.boolean().default(false),
});

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
/** Streams are cut after this many provider events, which is far beyond any real answer. */
const MAX_STREAM_EVENTS = 50_000;

export const POST = route(async (req: Request) => {
  const input = await parseBody(req, schema);
  const body = input.request.body;
  if (!body || body.mode !== "ai")
    throw new HttpError(400, "This is not an AI request (body mode must be ai)");
  try {
    buildAiPayload(body.ai);
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
  if (input.folderId) repo.requireFolderIn(input.workspaceId, input.folderId);
  if (input.environmentId) repo.requireEnvironmentIn(input.workspaceId, input.environmentId);
  const chain: FolderDef[] = input.folderId ? repo.getFolderChain(input.folderId) : [];
  const ctx = loadScopes(input.workspaceId, input.environmentId ?? null, chain[0]?.id ?? null);
  if (input.assistant) {
    if (input.folderId || input.environmentId)
      throw new HttpError(400, "Assistant model calls cannot inherit collection or environment context");
    body.ai = redactStoredValue(
      body.ai,
      credentialRedactionValues([
        ...ctx.secrets,
        ...authCredentialValues(input.request.auth ?? { type: "none" }),
      ]),
    );
  }
  const request = defaultRequest({
    ...input.request,
    method: "POST",
    settings: { ...DEFAULT_SETTINGS, ...(input.request.settings ?? {}) },
  });
  const { prepared, effectiveAuth, oauth2Token } = await prepareRequest(
    request,
    chain,
    new Resolver(input.assistant ? emptyScopes() : ctx.scopes),
    { policy: getPolicy(), oauth2CacheScope: input.workspaceId, signal: req.signal },
    { defaults: executionSettings().requestDefaults },
  );
  const provider = body.ai.provider;
  for (const [name, value] of providerHeaders(provider))
    if (!prepared.headers.some(([k]) => k.toLowerCase() === name)) prepared.headers.push([name, value]);
  const wantsStream = body.ai.stream;
  prepared.headers = prepared.headers.map(([k, v]) =>
    k.toLowerCase() === "accept" && v.trim() === "*/*"
      ? [k, wantsStream ? "text/event-stream" : "application/json"]
      : [k, v],
  );
  const secrets = credentialRedactionValues([
    ...ctx.secrets,
    ...authCredentialValues(effectiveAuth),
    oauth2Token?.accessToken ?? "",
  ]);
  const events = createEventStream();
  const started = Date.now();
  const send = (message: Record<string, unknown>) => events.send(redactStoredValue(message, secrets));
  const done = (result: AiResult, status: number | null) =>
    send({ type: "done", result, status, elapsedMs: Date.now() - started });

  const run = async () => {
    if (!wantsStream) {
      const response = await sendRequest(prepared, {
        policy: getPolicy(),
        maxBodyBytes: MAX_RESPONSE_BYTES,
        signal: req.signal,
      });
      send({ type: "open", status: response.status });
      const text = Buffer.from(response.bodyBase64, "base64").toString("utf8");
      if (response.status >= 400) {
        send({ type: "error", status: response.status, message: errorMessage(text) });
        return;
      }
      done(parseResponse(provider, text), response.status);
      return;
    }
    const decoder = createDecoder(provider);
    const accumulator = new AiAccumulator();
    let status: number | null = null;
    let failed = false;
    let finished = false;
    const emit = (list: AiEvent[]) => {
      for (const event of list) {
        accumulator.add(event);
        send(event);
      }
    };
    await streamEvents(
      prepared,
      (message) => {
        if (message.type === "open") {
          status = message.status;
          send({ type: "open", status });
        } else if (message.type === "event") emit(decoder.feed(message.event, message.data));
        else if (message.type === "rejected") {
          if (message.status === 200) {
            // A server that ignored `stream: true` answered with plain JSON.
            done(parseResponse(provider, message.body), 200);
            finished = true;
          } else {
            failed = true;
            send({ type: "error", status: message.status, message: errorMessage(message.body) });
          }
        } else if (message.type === "closed" && !failed && !finished) {
          finished = true;
          done(accumulator.result(), status);
        }
      },
      {
        policy: getPolicy(),
        signal: req.signal,
        maxEvents: MAX_STREAM_EVENTS,
        // Re-sending a model request would be a second, billed request.
        maxReconnects: 0,
        captureErrorBody: true,
      },
    );
  };
  void run()
    .catch((err: Error) => send({ type: "error", status: null, message: err.message }))
    .finally(events.close);
  return new Response(events.stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
});
