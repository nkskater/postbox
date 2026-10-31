/**
 * POST /api/graphql/subscribe — run a GraphQL subscription over graphql-transport-ws
 * or graphql-sse with the request's variables, headers and auth, and relay the
 * messages as NDJSON until it completes, hits the limit or the client disconnects.
 */
import { z } from "zod";
import type { FolderDef } from "@/core/types";
import { DEFAULT_SETTINGS } from "@/core/types";
import { requestInputSchema } from "@/core/schemas";
import { prepareRequest } from "@/core/http/prepare";
import { subscribeOverSse, subscribeOverWebSocket } from "@/core/graphql/subscribe";
import { Resolver, redactStoredValue } from "@/core/variables/resolver";
import { authCredentialValues, credentialRedactionValues } from "@/core/retention";
import { createEventStream } from "@/server/event-stream";
import { getPolicy, loadScopes } from "@/server/context";
import { executionSettings } from "@/server/execution-settings";
import { defaultRequest } from "@/server/defaults";
import { HttpError, parseBody, route } from "@/server/http";
import * as repo from "@/server/repo";

export const dynamic = "force-dynamic";

const schema = z.object({
  workspaceId: z.string().min(1),
  environmentId: z.string().nullish(),
  folderId: z.string().nullish(),
  request: requestInputSchema,
  transport: z.enum(["ws", "sse"]).default("ws"),
  /** JSON object sent as the graphql-transport-ws connection_init payload; variables allowed. */
  connectionParams: z
    .string()
    .max(16 * 1024)
    .optional(),
  maxMessages: z.number().int().min(1).max(5000).default(1000),
});

export const POST = route(async (req: Request) => {
  const input = await parseBody(req, schema);
  if (input.request.body?.mode !== "graphql") throw new HttpError(400, "Subscriptions need a GraphQL body");
  if (input.folderId) repo.requireFolderIn(input.workspaceId, input.folderId);
  if (input.environmentId) repo.requireEnvironmentIn(input.workspaceId, input.environmentId);
  const chain: FolderDef[] = input.folderId ? repo.getFolderChain(input.folderId) : [];
  const ctx = loadScopes(input.workspaceId, input.environmentId ?? null, chain[0]?.id ?? null);
  const resolver = new Resolver(ctx.scopes);
  const r = input.request;
  const request = defaultRequest({
    ...r,
    method: "POST",
    settings: { ...DEFAULT_SETTINGS, ...(r.settings ?? {}) },
  });
  const { prepared, effectiveAuth, oauth2Token } = await prepareRequest(
    request,
    chain,
    resolver,
    { policy: getPolicy(), oauth2CacheScope: input.workspaceId, signal: req.signal },
    { defaults: executionSettings().requestDefaults },
  );
  let connectionParams: Record<string, unknown> | undefined;
  if (input.connectionParams?.trim()) {
    try {
      const parsed = JSON.parse(resolver.resolve(input.connectionParams));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      connectionParams = parsed;
    } catch {
      throw new HttpError(400, "Connection params must be a JSON object");
    }
  }
  const secrets = credentialRedactionValues([
    ...ctx.secrets,
    ...authCredentialValues(effectiveAuth),
    oauth2Token?.accessToken ?? "",
  ]);
  const events = createEventStream();
  const run = input.transport === "sse" ? subscribeOverSse : subscribeOverWebSocket;
  void run(prepared, (e) => events.send(redactStoredValue(e, secrets)), {
    policy: getPolicy(),
    signal: req.signal,
    connectionParams,
    maxMessages: input.maxMessages,
  })
    .catch((err: Error) => events.send({ type: "error", error: redactStoredValue(err.message, secrets) }))
    .finally(events.close);
  return new Response(events.stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
});
