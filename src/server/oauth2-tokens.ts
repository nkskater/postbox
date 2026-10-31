/**
 * Saved OAuth 2.0 tokens across a workspace's requests and folders: list their
 * metadata (never the values), clear them, and optionally revoke them at the
 * provider first (RFC 7009).
 */
import { eq } from "drizzle-orm";
import type { AuthConfig, OAuth2Config } from "@/core/types";
import { resolveAuth, revokeOAuth2Token } from "@/core/http/auth";
import { Resolver } from "@/core/variables/resolver";
import { getDb, schema } from "./db";
import * as repo from "./repo";
import { getPolicy, loadScopes } from "./context";
import { notFound } from "./errors";

export interface SavedTokenInfo {
  kind: "request" | "folder";
  id: string;
  name: string;
  grantType: OAuth2Config["grantType"];
  tokenHost: string;
  expiresAt?: number;
  hasAccessToken: boolean;
  hasRefreshToken: boolean;
  canRevoke: boolean;
}

type Owner = {
  kind: "request" | "folder";
  id: string;
  name: string;
  auth: AuthConfig;
  collectionId: string | null;
};

function owners(workspaceId: string): Owner[] {
  const db = getDb();
  const folders = db.select().from(schema.folders).where(eq(schema.folders.workspaceId, workspaceId)).all();
  const parent = new Map(folders.map((f) => [f.id, f.parentId]));
  const rootOf = (id: string | null) => {
    let current = id;
    for (let i = 0; current && parent.get(current) && i < 200; i++) current = parent.get(current)!;
    return current;
  };
  const requests = db
    .select()
    .from(schema.requests)
    .where(eq(schema.requests.workspaceId, workspaceId))
    .all();
  return [
    ...folders.map((f) => ({
      kind: "folder" as const,
      id: f.id,
      name: f.name,
      auth: f.auth,
      collectionId: rootOf(f.id),
    })),
    ...requests.map((r) => ({
      kind: "request" as const,
      id: r.id,
      name: r.name,
      auth: r.auth,
      collectionId: rootOf(r.folderId),
    })),
  ];
}

const hasToken = (auth: AuthConfig): auth is Extract<AuthConfig, { type: "oauth2" }> =>
  auth.type === "oauth2" && !!(auth.oauth2.accessToken || auth.oauth2.refreshToken);

export function listSavedTokens(workspaceId: string): SavedTokenInfo[] {
  repo.requireWorkspace(workspaceId);
  return owners(workspaceId)
    .filter((o) => hasToken(o.auth))
    .map((o) => {
      const c = (o.auth as Extract<AuthConfig, { type: "oauth2" }>).oauth2;
      let tokenHost = "";
      try {
        tokenHost = new URL(c.accessTokenUrl).host;
      } catch {
        tokenHost = c.accessTokenUrl.includes("{{") ? c.accessTokenUrl : "";
      }
      return {
        kind: o.kind,
        id: o.id,
        name: o.name,
        grantType: c.grantType,
        tokenHost,
        ...(c.expiresAt !== undefined ? { expiresAt: c.expiresAt } : {}),
        hasAccessToken: !!c.accessToken,
        hasRefreshToken: !!c.refreshToken,
        canRevoke: !!c.revocationUrl,
      };
    });
}

export interface ClearResult {
  cleared: number;
  revoked: number;
  errors: string[];
}

async function clearOwner(workspaceId: string, owner: Owner, revoke: boolean, result: ClearResult) {
  if (!hasToken(owner.auth)) return;
  const saved = owner.auth.oauth2;
  if (revoke && saved.revocationUrl) {
    const ctx = loadScopes(workspaceId, null, owner.collectionId);
    const resolved = resolveAuth(owner.auth, new Resolver(ctx.scopes));
    const config = resolved.type === "oauth2" ? resolved.oauth2 : saved;
    // Revoke the refresh token first: providers then also invalidate the access tokens issued from it.
    const tokens: [string | undefined, "refresh_token" | "access_token"][] = [
      [saved.refreshToken, "refresh_token"],
      [saved.accessToken, "access_token"],
    ];
    for (const [value, hint] of tokens) {
      if (!value) continue;
      try {
        await revokeOAuth2Token(config, value, hint, { policy: getPolicy() });
        result.revoked++;
      } catch (err) {
        result.errors.push(`${owner.name}: ${(err as Error).message}`);
      }
    }
  }
  // Clear locally even when revocation failed, so the token is no longer used.
  const auth: AuthConfig = {
    type: "oauth2",
    oauth2: {
      ...saved,
      accessToken: "",
      refreshToken: undefined,
      expiresAt: undefined,
      tokenContext: undefined,
      tokenType: undefined,
    },
  };
  if (owner.kind === "folder") repo.updateFolder(owner.id, { auth });
  else repo.updateRequest(owner.id, { auth });
  result.cleared++;
}

export async function clearSavedToken(
  workspaceId: string,
  target: { kind: "request" | "folder"; id: string },
  revoke = false,
): Promise<ClearResult> {
  const owner = owners(workspaceId).find((o) => o.kind === target.kind && o.id === target.id);
  if (!owner) throw notFound(target.kind === "folder" ? "Folder" : "Request");
  const result: ClearResult = { cleared: 0, revoked: 0, errors: [] };
  await clearOwner(workspaceId, owner, revoke, result);
  return result;
}

export async function clearAllSavedTokens(workspaceId: string, revoke = false): Promise<ClearResult> {
  repo.requireWorkspace(workspaceId);
  const result: ClearResult = { cleared: 0, revoked: 0, errors: [] };
  for (const owner of owners(workspaceId)) await clearOwner(workspaceId, owner, revoke, result);
  return result;
}
