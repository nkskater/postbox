/**
 * Variable scopes and {{variable}} substitution.
 *
 * Precedence (lowest → highest), matching Postman:
 *   global < collection < environment < data (iteration) < local
 */
import type { Variable } from "../types";
import { generateDynamic, isDynamicVariable } from "./dynamic";

export type ScopeName = "globals" | "collection" | "environment" | "data" | "local";

/** Highest precedence first. */
export const SCOPE_PRECEDENCE: ScopeName[] = ["local", "data", "environment", "collection", "globals"];

export interface VariableScopes {
  globals: Record<string, string>;
  collection: Record<string, string>;
  environment: Record<string, string>;
  data: Record<string, string>;
  local: Record<string, string>;
  /**
   * Secrets vault values this execution may reference as {{vault:name}} (the server decrypts only what the
   * collection is scoped for). Never sent to scripts as a variable scope and never persisted.
   */
  vault?: Record<string, string>;
  /** Names from `vault` that scripts may read with pm.vault.get(). */
  vaultScripts?: string[];
}

/** Prefix of a vault reference inside {{ }}. */
export const VAULT_PREFIX = "vault:";

export const MAX_RESOLVE_DEPTH = 10;

/** Matches {{name}}; names may not contain braces. */
export const VARIABLE_PATTERN = /\{\{\s*([^{}]+?)\s*\}\}/g;

export function emptyScopes(): VariableScopes {
  return { globals: {}, collection: {}, environment: {}, data: {}, local: {} };
}

/** Convert a variable list to a plain record, skipping disabled and empty-key entries. */
export function variablesToRecord(vars: Variable[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const v of vars ?? []) {
    if (v.enabled !== false && v.key) out[v.key] = v.value ?? "";
  }
  return out;
}

/** Find the value of a variable across scopes, returning the winning scope too. */
export function lookupVariable(
  scopes: VariableScopes,
  name: string,
): { value: string; scope: ScopeName | "vault" } | undefined {
  if (name.startsWith(VAULT_PREFIX)) {
    const key = name.slice(VAULT_PREFIX.length);
    const vault = scopes.vault;
    return vault && Object.prototype.hasOwnProperty.call(vault, key)
      ? { value: String(vault[key]), scope: "vault" }
      : undefined;
  }
  for (const scope of SCOPE_PRECEDENCE) {
    const bag = scopes[scope];
    if (bag && Object.prototype.hasOwnProperty.call(bag, name)) return { value: String(bag[name]), scope };
  }
  return undefined;
}

export interface ResolveResult {
  value: string;
  /** Variable names that could not be resolved (deduplicated). */
  unresolved: string[];
}

/**
 * Replace every {{name}} in `input`. Values that themselves contain variables
 * are resolved recursively up to MAX_RESOLVE_DEPTH levels. Unknown variables
 * are left untouched and reported in `unresolved`.
 */
export function resolveTemplate(input: string, scopes: VariableScopes): ResolveResult {
  const unresolved = new Set<string>();
  const value = resolveInner(input ?? "", scopes, unresolved, 0);
  return { value, unresolved: [...unresolved] };
}

function resolveInner(input: string, scopes: VariableScopes, unresolved: Set<string>, depth: number): string {
  if (!input.includes("{{")) return input;
  return input.replace(VARIABLE_PATTERN, (match, rawName: string) => {
    const name = rawName.trim();
    const found = lookupVariable(scopes, name);
    if (found) {
      // A vault value is data, not a template: braces inside a secret must survive untouched.
      if (found.scope === "vault" || depth >= MAX_RESOLVE_DEPTH) return found.value;
      return resolveInner(found.value, scopes, unresolved, depth + 1);
    }
    if (isDynamicVariable(name)) return generateDynamic(name)!;
    unresolved.add(name);
    return match;
  });
}

/** Convenience wrapper returning only the substituted string. */
export function replaceVariables(input: string, scopes: VariableScopes): string {
  return resolveTemplate(input, scopes).value;
}

/** Collects unresolved names across many templates. */
export class Resolver {
  readonly unresolved = new Set<string>();
  constructor(public scopes: VariableScopes) {}

  resolve(input: string | undefined): string {
    if (!input) return input ?? "";
    const r = resolveTemplate(input, this.scopes);
    r.unresolved.forEach((n) => this.unresolved.add(n));
    return r.value;
  }
}

/** Extract variable names referenced in a template (for UI highlighting). */
export function extractVariableNames(input: string): string[] {
  const names: string[] = [];
  for (const m of input.matchAll(VARIABLE_PATTERN)) names.push(m[1].trim());
  return names;
}

/**
 * Redact the values of secret variables from free text (logs, console output).
 * Very short values are skipped to avoid redacting common substrings.
 */
export const REDACTION_MASK = "********";

export function redactSecrets(text: string, secrets: Iterable<string>): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 3) out = out.split(secret).join(REDACTION_MASK);
  }
  return out;
}

/** Redact structured persistence payloads without serializing secrets into JSON first. */
export function redactStoredValue<T>(value: T, secrets: Iterable<string>): T {
  const patterns = [
    ...new Set(
      [...secrets].filter(Boolean).flatMap((secret) => {
        let encoded = secret;
        try {
          encoded = encodeURIComponent(secret);
        } catch {
          /* preserve malformed Unicode literally */
        }
        return [
          secret,
          encoded,
          encoded.replace(/%[0-9A-F]{2}/g, (match) => match.toLowerCase()),
          encoded.replace(/%20/g, "+"),
          JSON.stringify(secret).slice(1, -1),
        ];
      }),
    ),
  ].sort((a, b) => b.length - a.length);
  const matcher = patterns.length
    ? new RegExp(patterns.map((pattern) => pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g")
    : undefined;
  const scrub = (input: unknown): unknown => {
    if (typeof input === "string") {
      return matcher ? input.replace(matcher, "********") : input;
    }
    if (Array.isArray(input)) return input.map(scrub);
    if (input && typeof input === "object")
      return Object.fromEntries(Object.entries(input).map(([key, entry]) => [key, scrub(entry)]));
    return input;
  };
  return scrub(value) as T;
}
