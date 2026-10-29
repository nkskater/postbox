/**
 * POST /api/oauth2/token — fetch an OAuth 2.0 access token server-side using the
 * active environment/collection variables.
 */
import { z } from "zod";
import type { OAuth2Config } from "@/core/types";
import { fetchOAuth2Token, resolveAuth } from "@/core/http/auth";
import { Resolver } from "@/core/variables/resolver";
import * as repo from "@/server/repo";
import { getPolicy, loadScopes } from "@/server/context";
import { HttpError, json, parseBody, route } from "@/server/http";

export const POST = route(async (req: Request) => {
  const input = await parseBody(
    req,
    z.object({
      workspaceId: z.string(),
      environmentId: z.string().nullish(),
      folderId: z.string().nullish(),
      config: z.record(z.string(), z.unknown()),
    }),
  );
  const collectionId = input.folderId ? (repo.getFolderChain(input.folderId)[0]?.id ?? null) : null;
  const ctx = loadScopes(input.workspaceId, input.environmentId ?? null, collectionId);
  const resolved = resolveAuth(
    { type: "oauth2", oauth2: input.config as unknown as OAuth2Config },
    new Resolver(ctx.scopes),
  );
  if (resolved.type !== "oauth2") throw new HttpError(400, "Invalid OAuth2 config");
  try {
    const token = await fetchOAuth2Token(resolved.oauth2, { policy: getPolicy() });
    return json({ accessToken: token.accessToken, tokenType: token.tokenType, expiresAt: token.expiresAt });
  } catch (err) {
    throw new HttpError(502, (err as Error).message);
  }
});
