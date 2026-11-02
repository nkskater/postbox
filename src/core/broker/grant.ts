/** Deciding whether a grant lets this caller make this call, with no database or framework in sight. */
import { pathAllowed, type BrokerMethod } from "./target";

export type GrantStatus = "pending" | "approved" | "denied" | "revoked";

export interface GrantFacts {
  status: GrantStatus;
  consumerId: string;
  /** Set when the grant is bound to one API key as well as its owner. */
  tokenId: string | null;
  methods: readonly string[];
  pathPrefixes: readonly string[];
  expiresAt: number | null;
}

export interface ApiFacts {
  enabled: boolean;
  methods: readonly string[];
  pathPrefixes: readonly string[];
}

export interface CallerFacts {
  id: string | null;
  tokenId: string | null;
}

export type Verdict =
  | { ok: true }
  | { ok: false; code: "caller" | "status" | "expired" | "disabled" | "method" | "path"; reason: string };

const no = (code: Exclude<Verdict, { ok: true }>["code"], reason: string): Verdict => ({
  ok: false,
  code,
  reason,
});

/**
 * The order matters: identity first, so another caller learns nothing about the grant's state, then the grant's
 * own status and expiry, then what the call itself asks for.
 */
export function evaluateCall(
  grant: GrantFacts,
  api: ApiFacts,
  caller: CallerFacts,
  call: { method: BrokerMethod; path: string },
  now: number,
): Verdict {
  if (caller.id === null || caller.id !== grant.consumerId)
    return no("caller", "This access reference belongs to another consumer");
  if (grant.tokenId && grant.tokenId !== caller.tokenId)
    return no("caller", "This access reference is bound to a different API key");
  if (grant.status !== "approved") return no("status", `Access is ${grant.status}`);
  if (grant.expiresAt !== null && grant.expiresAt <= now) return no("expired", "Access has expired");
  if (!api.enabled) return no("disabled", "This API is disabled");
  const allowedMethods = grant.methods.length ? grant.methods : api.methods;
  if (allowedMethods.length && !allowedMethods.includes(call.method))
    return no("method", `${call.method} is not allowed for this access`);
  if (!pathAllowed(api.pathPrefixes, call.path) || !pathAllowed(grant.pathPrefixes, call.path))
    return no("path", "That path is outside what this access allows");
  return { ok: true };
}
