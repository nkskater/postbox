/**
 * POST /api/sse — open a server-sent event stream for a request (variables, auth,
 * inherited headers and policy applied; scripts are not run) and relay its events
 * as NDJSON until the client disconnects, the stream ends or the event limit is hit.
 */
import { z } from "zod";
import type { FolderDef } from "@/core/types";
import { DEFAULT_SETTINGS } from "@/core/types";
import { requestInputSchema } from "@/core/schemas";
import { prepareRequest } from "@/core/http/prepare";
import { streamEvents } from "@/core/http/sse";
import { Resolver, redactStoredValue } from "@/core/variables/resolver";
import { authCredentialValues, credentialRedactionValues } from "@/core/retention";
import { createEventStream } from "@/server/event-stream";
import { getPolicy, loadScopes } from "@/server/context";
import { executionSettings } from "@/server/execution-settings";
import { defaultRequest } from "@/server/defaults";
import { parseBody, route } from "@/server/http";
import * as repo from "@/server/repo";

export const dynamic = "force-dynamic";

const schema = z.object({
  workspaceId: z.string().min(1),
  environmentId: z.string().nullish(),
  folderId: z.string().nullish(),
  request: requestInputSchema,
  maxEvents: z.number().int().min(1).max(5000).default(1000),
  maxReconnects: z.number().int().min(0).max(20).default(3),
});

export const POST = route(async (req: Request) => {
  const input = await parseBody(req, schema);
  if (input.folderId) repo.requireFolderIn(input.workspaceId, input.folderId);
  if (input.environmentId) repo.requireEnvironmentIn(input.workspaceId, input.environmentId);
  const chain: FolderDef[] = input.folderId ? repo.getFolderChain(input.folderId) : [];
  const ctx = loadScopes(input.workspaceId, input.environmentId ?? null, chain[0]?.id ?? null);
  const r = input.request;
  const request = defaultRequest({ ...r, settings: { ...DEFAULT_SETTINGS, ...(r.settings ?? {}) } });
  const { prepared, effectiveAuth, oauth2Token } = await prepareRequest(
    request,
    chain,
    new Resolver(ctx.scopes),
    { policy: getPolicy(), oauth2CacheScope: input.workspaceId, signal: req.signal },
    { defaults: executionSettings().requestDefaults },
  );
  // The automatic Accept: */* would hide the event-stream preference.
  prepared.headers = prepared.headers.map(([k, v]) =>
    k.toLowerCase() === "accept" && v.trim() === "*/*" ? [k, "text/event-stream"] : [k, v],
  );
  const secrets = credentialRedactionValues([
    ...ctx.secrets,
    ...authCredentialValues(effectiveAuth),
    oauth2Token?.accessToken ?? "",
  ]);
  const events = createEventStream();
  void streamEvents(
    prepared,
    (message) => {
      const safe = redactStoredValue(message, secrets);
      events.send(safe.type === "closed" ? { ...safe, type: "done" } : safe);
    },
    {
      policy: getPolicy(),
      signal: req.signal,
      maxEvents: input.maxEvents,
      maxReconnects: input.maxReconnects,
    },
  )
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
