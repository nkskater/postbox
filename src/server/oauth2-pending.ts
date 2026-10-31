/**
 * In-flight authorization-code logins, keyed by their single-use state value.
 * Each entry is bound to the user and workspace that started it and expires after
 * ten minutes. The PKCE verifier never leaves the server.
 */
import type { OAuth2Config } from "@/core/types";
import type { OAuth2Token } from "@/core/http/auth";

export const PENDING_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING = 200;

export interface PendingAuthorization {
  owner: string;
  workspaceId: string;
  config: OAuth2Config;
  redirectUri: string;
  verifier?: string;
  createdAt: number;
  result?: { token: OAuth2Token } | { error: string };
}

const store = ((
  globalThis as unknown as { __postboxOAuth2Pending?: Map<string, PendingAuthorization> }
).__postboxOAuth2Pending ??= new Map());

function sweep(now = Date.now()) {
  for (const [state, entry] of store) if (now - entry.createdAt > PENDING_TTL_MS) store.delete(state);
}

export function addPending(state: string, entry: PendingAuthorization) {
  sweep();
  while (store.size >= MAX_PENDING) store.delete(store.keys().next().value!);
  store.set(state, entry);
}

export function getPending(state: string): PendingAuthorization | undefined {
  sweep();
  return store.get(state);
}

export function deletePending(state: string) {
  store.delete(state);
}
