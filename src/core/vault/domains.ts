/**
 * Allowed domains for vault secrets. A secret with domains may only be sent to a matching host: a mistyped URL, a
 * redirect, a shared collection edited by someone else or a script cannot send it anywhere else. A secret without
 * domains works with any host. Pure.
 *
 * Patterns: `api.example.com` (exact), `*.example.com` (any subdomain, not the apex), an IP address, or `localhost`.
 * Ports and schemes are ignored.
 */
import net from "node:net";

export const MAX_DOMAINS = 20;

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const normalize = (host: string) =>
  host
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");

export class DomainPatternError extends Error {}

/** Validate and normalize patterns; throws DomainPatternError naming the bad one. */
export function parseDomains(input: readonly string[] | string): string[] {
  const list = (typeof input === "string" ? input.split(",") : [...input])
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  if (list.length > MAX_DOMAINS) throw new DomainPatternError(`At most ${MAX_DOMAINS} domains are allowed`);
  for (const pattern of list) {
    const host = pattern.startsWith("*.") ? pattern.slice(2) : pattern;
    const bare = normalize(host);
    const ok =
      pattern !== "*" &&
      bare.length <= 253 &&
      (net.isIP(bare) ? !pattern.startsWith("*.") : bare.split(".").every((l) => LABEL.test(l)));
    if (!ok) throw new DomainPatternError(`"${pattern}" is not a host name, *.domain or IP address`);
  }
  return [...new Set(list)];
}

export function domainMatches(patterns: readonly string[], hostname: string): boolean {
  if (patterns.length === 0) return true;
  const host = normalize(hostname);
  return patterns.some((p) =>
    p.startsWith("*.") ? host.endsWith(p.slice(1)) && host.length > p.length - 1 : host === normalize(p),
  );
}

export interface GuardedSecret {
  name: string;
  value: string;
  domains: readonly string[];
}

export interface OutgoingMessage {
  url: string;
  headers: readonly (readonly [string, string])[];
  body?: Buffer | string | null;
}

/** The ways a secret's text can appear in what is about to be sent: raw, URL-encoded, inside Basic credentials. */
function variants(value: string): string[] {
  const out = new Set([value]);
  try {
    out.add(encodeURIComponent(value));
    out.add(encodeURI(value));
  } catch {
    /* lone surrogates: the raw form is still checked */
  }
  out.add(JSON.stringify(value).slice(1, -1));
  return [...out].filter((v) => v.length >= 3);
}

/**
 * Secrets that would be sent to a host they are not allowed for. Scans the URL, header values (decoding Basic
 * credentials) and the body, so a secret is caught wherever it was placed, including by a script.
 */
export function misdirectedSecrets(secrets: readonly GuardedSecret[], message: OutgoingMessage): string[] {
  let host = "";
  try {
    host = new URL(message.url).hostname;
  } catch {
    /* an unparsable URL is rejected elsewhere */
  }
  const restricted = secrets.filter((s) => s.domains.length > 0 && !domainMatches(s.domains, host));
  if (!restricted.length) return [];
  const parts: string[] = [message.url];
  try {
    parts.push(decodeURI(message.url));
  } catch {
    /* keep the raw form */
  }
  for (const [name, value] of message.headers) {
    parts.push(value);
    const basic = /^\s*basic\s+(\S+)/i.exec(value);
    if (basic && name.toLowerCase().endsWith("authorization"))
      parts.push(Buffer.from(basic[1], "base64").toString("utf8"));
  }
  if (message.body) {
    const buf = Buffer.isBuffer(message.body) ? message.body : Buffer.from(message.body);
    parts.push(buf.toString("utf8"), buf.toString("latin1"));
  }
  return restricted
    .filter((s) => variants(s.value).some((v) => parts.some((p) => p.includes(v))))
    .map((s) => s.name);
}
