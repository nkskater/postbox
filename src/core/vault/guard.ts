/** Builds the check that keeps domain-restricted vault secrets from being sent to the wrong host. */
import type { VariableScopes } from "../variables/resolver";
import { misdirectedSecrets, type GuardedSecret, type OutgoingMessage } from "./domains";

export class VaultDomainError extends Error {
  constructor(
    message: string,
    public secrets: string[],
  ) {
    super(message);
    this.name = "VaultDomainError";
  }
}

/** The domain-restricted secrets of an execution, or an empty list. */
export function guardedSecrets(scopes: Pick<VariableScopes, "vault" | "vaultDomains">): GuardedSecret[] {
  if (!scopes.vault || !scopes.vaultDomains) return [];
  return Object.entries(scopes.vaultDomains)
    .filter(([name]) => Object.hasOwn(scopes.vault!, name) && scopes.vault![name])
    .map(([name, domains]) => ({ name, value: scopes.vault![name], domains }));
}

/** A reason string when the message would send a restricted secret to a host it is not allowed for. */
export function checkVaultDomains(
  secrets: readonly GuardedSecret[],
  message: OutgoingMessage,
): string | null {
  if (!secrets.length) return null;
  const names = misdirectedSecrets(secrets, message);
  if (!names.length) return null;
  let host = message.url;
  try {
    host = new URL(message.url).hostname;
  } catch {
    /* show the raw text */
  }
  const first = secrets.find((s) => s.name === names[0])!;
  return `The vault secret "${names[0]}"${names.length > 1 ? ` (and ${names.length - 1} more)` : ""} may only be sent to ${first.domains.join(", ")}; this request goes to ${host}. Nothing was sent.`;
}
