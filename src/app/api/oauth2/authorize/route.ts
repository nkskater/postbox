/**
 * POST /api/oauth2/authorize — start an authorization-code login: resolve the
 * config, create state and a PKCE verifier, and return the provider URL to open.
 * GET  /api/oauth2/authorize?state= — collect the result once the callback ran.
 */
import { z } from "zod";
import { resolveAuth } from "@/core/http/auth";
import { buildAuthorizationUrl, createPkce, createState } from "@/core/http/oauth2-pkce";
import { Resolver } from "@/core/variables/resolver";
import { oauth2ConfigSchema } from "@/core/schemas";
import * as repo from "@/server/repo";
import { loadScopes } from "@/server/context";
import { HttpError, json, parseBody, route } from "@/server/http";
import { addPending, deletePending, getPending } from "@/server/oauth2-pending";
import { oauth2Owner } from "@/server/oauth2-owner";

export const POST = route(async (req: Request) => {
  const input = await parseBody(
    req,
    z.object({
      workspaceId: z.string(),
      environmentId: z.string().nullish(),
      folderId: z.string().nullish(),
      /** The editor's default: this server's /api/oauth2/callback as seen by the browser. */
      callbackUrl: z.string().url(),
      config: oauth2ConfigSchema,
    }),
  );
  if (input.folderId) repo.requireFolderIn(input.workspaceId, input.folderId);
  if (input.environmentId) repo.requireEnvironmentIn(input.workspaceId, input.environmentId);
  const collectionId = input.folderId ? (repo.getFolderChain(input.folderId)[0]?.id ?? null) : null;
  const ctx = loadScopes(input.workspaceId, input.environmentId ?? null, collectionId);
  const resolved = resolveAuth(
    { type: "oauth2", oauth2: { ...input.config, grantType: "authorization_code" } },
    new Resolver(ctx.scopes),
  );
  if (resolved.type !== "oauth2") throw new HttpError(400, "Invalid OAuth2 config");
  const config = resolved.oauth2;
  // The callback route is only reachable on this server's own /api/oauth2/callback path.
  const callback = new URL(input.callbackUrl);
  if (callback.pathname !== "/api/oauth2/callback") throw new HttpError(400, "Invalid callback URL");
  const redirectUri = config.redirectUri?.trim() || callback.toString();
  const pkce = config.usePkce === false ? undefined : createPkce(config.codeChallengeMethod ?? "S256");
  const state = createState();
  let authorizationUrl: string;
  try {
    authorizationUrl = buildAuthorizationUrl(config, { state, redirectUri, pkce });
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
  addPending(state, {
    owner: oauth2Owner(),
    workspaceId: input.workspaceId,
    config,
    redirectUri,
    verifier: pkce?.verifier,
    createdAt: Date.now(),
  });
  return json({ authorizationUrl, state, redirectUri });
});

export const GET = route((req: Request) => {
  const state = new URL(req.url).searchParams.get("state") ?? "";
  const pending = getPending(state);
  // Unknown, expired and foreign states are indistinguishable.
  if (!pending || pending.owner !== oauth2Owner())
    throw new HttpError(404, "Authorization not found or expired");
  if (!pending.result) return json({ status: "pending" });
  deletePending(state);
  if ("error" in pending.result) return json({ status: "error", error: pending.result.error });
  const { token } = pending.result;
  return json({
    status: "done",
    accessToken: token.accessToken,
    tokenType: token.tokenType,
    expiresAt: token.expiresAt,
    tokenContext: token.contextKey,
    ...(token.refreshToken ? { refreshToken: token.refreshToken } : {}),
  });
});
