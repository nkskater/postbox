/**
 * POST /api/mqtt — connect to an MQTT broker for a request (Basic auth supplies
 * the credentials; host policy applies) and stream events as NDJSON. The first
 * line names the session for the publish/subscribe/unsubscribe/close routes.
 */
import { z } from "zod";
import type { AuthConfig, FolderDef } from "@/core/types";
import { DEFAULT_SETTINGS } from "@/core/types";
import { requestInputSchema } from "@/core/schemas";
import { connectMqtt } from "@/core/mqtt/client";
import { normalizeUrl } from "@/core/http/prepare";
import { resolveAuth, resolveEffectiveAuth } from "@/core/http/auth";
import { Resolver, redactStoredValue } from "@/core/variables/resolver";
import { authCredentialValues, credentialRedactionValues } from "@/core/retention";
import { createEventStream } from "@/server/event-stream";
import { getPolicy, loadScopes } from "@/server/context";
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
  const resolver = new Resolver(ctx.scopes);
  const r = input.request;
  const settings = { ...DEFAULT_SETTINGS, ...(r.settings ?? {}) };
  const auth: AuthConfig = resolveAuth(
    resolveEffectiveAuth([
      ...chain.map((f) => f.auth),
      (r.auth as AuthConfig | undefined) ?? { type: "inherit" },
    ]),
    resolver,
  );
  if (auth.type !== "basic" && auth.type !== "none" && auth.type !== "inherit")
    throw new HttpError(400, "MQTT uses Basic auth for its username and password");
  const credentials = auth.type === "basic" ? auth.basic : {};
  const secrets = credentialRedactionValues([...ctx.secrets, ...authCredentialValues(auth)]);
  const prepared = {
    method: "CONNECT",
    url: normalizeUrl(resolver.resolve(r.url ?? "")),
    headers: [] as [string, string][],
    settings,
  };
  const events = createEventStream();
  let sessionId = "";
  let connection;
  try {
    connection = await connectMqtt(
      prepared,
      settings.mqtt ?? {},
      credentials,
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
    throw new HttpError(400, redactStoredValue((err as Error).message, secrets));
  }
  const session = registerSession(oauth2Owner(), input.workspaceId, { kind: "mqtt", connection });
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
