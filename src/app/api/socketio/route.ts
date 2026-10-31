/**
 * POST /api/socketio — connect to a Socket.IO namespace for a request (variables,
 * inherited headers, auth and host policy applied) and stream its events as
 * NDJSON. The first line names the session for /api/socketio/[id]/emit and /close.
 */
import { z } from "zod";
import type { FolderDef } from "@/core/types";
import { DEFAULT_SETTINGS } from "@/core/types";
import { requestInputSchema } from "@/core/schemas";
import { prepareRequest } from "@/core/http/prepare";
import { connectSocketIo } from "@/core/socketio/client";
import { Resolver, redactStoredValue } from "@/core/variables/resolver";
import { authCredentialValues, credentialRedactionValues } from "@/core/retention";
import { createEventStream } from "@/server/event-stream";
import { getPolicy, loadScopes } from "@/server/context";
import { executionSettings } from "@/server/execution-settings";
import { defaultRequest } from "@/server/defaults";
import { HttpError, parseBody, route } from "@/server/http";
import { oauth2Owner } from "@/server/oauth2-owner";
import {
  MAX_SESSIONS,
  registerSession,
  removeSession,
  sessionCount,
  touchSession,
} from "@/server/ws-sessions";
import * as repo from "@/server/repo";

export const dynamic = "force-dynamic";

const schema = z.object({
  workspaceId: z.string().min(1),
  environmentId: z.string().nullish(),
  folderId: z.string().nullish(),
  request: requestInputSchema,
});

export const POST = route(async (req: Request) => {
  const input = await parseBody(req, schema);
  if (sessionCount() >= MAX_SESSIONS) throw new HttpError(429, "Too many open connections");
  if (input.folderId) repo.requireFolderIn(input.workspaceId, input.folderId);
  if (input.environmentId) repo.requireEnvironmentIn(input.workspaceId, input.environmentId);
  const chain: FolderDef[] = input.folderId ? repo.getFolderChain(input.folderId) : [];
  const ctx = loadScopes(input.workspaceId, input.environmentId ?? null, chain[0]?.id ?? null);
  const r = input.request;
  const settings = { ...DEFAULT_SETTINGS, ...(r.settings ?? {}) };
  const request = defaultRequest({ ...r, method: "GET", body: { mode: "none" }, settings });
  const { prepared, effectiveAuth, oauth2Token } = await prepareRequest(
    request,
    chain,
    new Resolver(ctx.scopes),
    { policy: getPolicy(), oauth2CacheScope: input.workspaceId, signal: req.signal },
    { defaults: executionSettings().requestDefaults },
  );
  const secrets = credentialRedactionValues([
    ...ctx.secrets,
    ...authCredentialValues(effectiveAuth),
    oauth2Token?.accessToken ?? "",
  ]);
  const events = createEventStream();
  let sessionId = "";
  let connection;
  try {
    connection = connectSocketIo(
      prepared,
      settings.socketio ?? {},
      (e) => {
        events.send(redactStoredValue(e.type === "close" ? { ...e, type: "done" } : e, secrets));
        if (e.type === "close") {
          removeSession(sessionId);
          events.close();
        }
      },
      { policy: getPolicy(), signal: req.signal },
    );
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
  const session = registerSession(oauth2Owner(), input.workspaceId, { kind: "socketio", connection });
  sessionId = session.id;
  touchSession(session);
  events.send({ type: "session", id: session.id });
  return new Response(events.stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
});
