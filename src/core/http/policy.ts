/**
 * Host allow/deny policy for outgoing requests.
 *
 * Patterns (comma separated in PROXY_ALLOW_HOSTS / PROXY_DENY_HOSTS):
 *   - exact host names:      api.example.com
 *   - wildcards:             *.example.com   (matches sub-domains, not the apex)
 *   - IP addresses:          10.0.0.5, ::1
 *   - CIDR ranges:           10.0.0.0/8, fd00::/8
 *   - everything:            *
 *
 * Deny rules always win. If the allow list is non-empty, a target must match it.
 * Both the host name and the resolved IP address are checked, so a public name
 * that resolves to a denied private address is still blocked.
 *
 * Unix domain sockets and Windows named pipes (PROXY_ALLOW_SOCKETS) are denied
 * unless listed: exact absolute paths, or "dir/*" for sockets directly inside a
 * directory. Symlinks are resolved before matching.
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

export class HostPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostPolicyError";
  }
}

interface CompiledRules {
  names: string[];
  wildcards: string[];
  any: boolean;
  blocks: net.BlockList;
  hasBlocks: boolean;
  empty: boolean;
}

function normalizeHost(host: string): string {
  return host
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
}

function validHostname(host: string): boolean {
  return (
    host.length <= 253 &&
    !/^[\d.]+$/.test(host) &&
    host.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  );
}

function compile(patterns: string[], setting: string): CompiledRules {
  const rules: CompiledRules = {
    names: [],
    wildcards: [],
    any: false,
    blocks: new net.BlockList(),
    hasBlocks: false,
    empty: patterns.length === 0,
  };
  for (const raw of patterns) {
    const p = raw.trim().toLowerCase();
    const invalid = () =>
      new HostPolicyError(
        `Invalid ${setting} pattern "${raw}": expected a hostname, *.hostname, IP address, CIDR, or *`,
      );
    if (p === "*") rules.any = true;
    else if (p.startsWith("*.")) {
      const suffix = normalizeHost(p.slice(2));
      if (!validHostname(suffix) || net.isIP(suffix)) throw invalid();
      rules.wildcards.push("." + suffix);
    } else if (p.includes("/")) {
      const parts = p.split("/");
      const [addr, prefix] = parts;
      const version = net.isIP(addr);
      if (
        parts.length !== 2 ||
        !version ||
        !/^\d+$/.test(prefix) ||
        Number(prefix) > (version === 6 ? 128 : 32)
      )
        throw invalid();
      rules.blocks.addSubnet(addr, Number(prefix), version === 6 ? "ipv6" : "ipv4");
      rules.hasBlocks = true;
    } else {
      const host = normalizeHost(p);
      if (p.includes("[") || p.includes("]")) {
        if (!/^\[[^\[\]]+\]$/.test(p) || !net.isIPv6(host)) throw invalid();
      }
      if (net.isIP(host)) {
        rules.blocks.addAddress(host, net.isIPv6(host) ? "ipv6" : "ipv4");
        rules.hasBlocks = true;
      } else {
        if (!validHostname(host)) throw invalid();
        rules.names.push(host);
      }
    }
  }
  rules.empty = !rules.any && !rules.names.length && !rules.wildcards.length && !rules.hasBlocks;
  return rules;
}

function matches(rules: CompiledRules, host: string, ip?: string): boolean {
  if (rules.any) return true;
  const h = normalizeHost(host);
  if (rules.names.includes(h)) return true;
  if (rules.wildcards.some((w) => h.endsWith(w) && h.length > w.length)) return true;
  if (rules.hasBlocks) {
    for (const addr of [h, ip]) {
      if (addr && net.isIP(addr) && rules.blocks.check(addr, net.isIPv6(addr) ? "ipv6" : "ipv4")) return true;
    }
  }
  return false;
}

const PIPE = /^\\\\[.?]\\pipe\\[^\\]+$/i;

/** Normalize a socket path or named pipe; null when it is not an absolute local endpoint. */
export function normalizeSocketPath(raw: string): string | null {
  const p = raw.trim();
  if (PIPE.test(p)) return p.toLowerCase().replace(/^\\\\\?\\/, "\\\\.\\");
  if (!path.isAbsolute(p) || p.includes("\0")) return null;
  let resolved = path.resolve(p);
  try {
    resolved = fs.realpathSync(resolved);
  } catch {
    // A missing socket fails at connect time; match the literal path.
  }
  return resolved;
}

function compileSockets(patterns: string[]): { exact: Set<string>; dirs: string[] } {
  const exact = new Set<string>();
  const dirs: string[] = [];
  for (const raw of patterns) {
    const p = raw.trim();
    if (!p) continue;
    const dir = p.endsWith("/*") || p.endsWith("\\*") ? p.slice(0, -2) : null;
    const normalized = normalizeSocketPath(dir ?? p);
    if (!normalized || (dir !== null && PIPE.test(dir)))
      throw new HostPolicyError(
        `Invalid PROXY_ALLOW_SOCKETS entry "${raw}": expected an absolute socket path, dir/*, or \\\\.\\pipe\\name`,
      );
    if (dir !== null) dirs.push(normalized);
    else exact.add(normalized);
  }
  return { exact, dirs };
}

export class HostPolicy {
  private allow: CompiledRules;
  private deny: CompiledRules;
  private sockets: { exact: Set<string>; dirs: string[] };

  constructor(allow: string[] = [], deny: string[] = [], sockets: string[] = []) {
    this.allow = compile(allow, "PROXY_ALLOW_HOSTS");
    this.deny = compile(deny, "PROXY_DENY_HOSTS");
    this.sockets = compileSockets(sockets);
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): HostPolicy {
    const split = (v?: string) => (v?.trim() ? v.split(",") : []);
    return new HostPolicy(
      split(env.PROXY_ALLOW_HOSTS),
      split(env.PROXY_DENY_HOSTS),
      split(env.PROXY_ALLOW_SOCKETS),
    );
  }

  /** Returns null when the socket or pipe may be used, or a reason string. */
  checkSocket(socketPath: string): string | null {
    const normalized = normalizeSocketPath(socketPath);
    if (!normalized) return `Socket "${socketPath}" must be an absolute path or a \\\\.\\pipe\\ name`;
    if (this.sockets.exact.has(normalized)) return null;
    if (this.sockets.dirs.some((dir) => path.dirname(normalized) === dir)) return null;
    return `Socket "${socketPath}" is not in PROXY_ALLOW_SOCKETS`;
  }

  assertSocket(socketPath: string): void {
    const reason = this.checkSocket(socketPath);
    if (reason) throw new HostPolicyError(reason);
  }

  /** Returns null when allowed, or a reason string when blocked. */
  check(host: string, ip?: string): string | null {
    // Literal addresses bypass Node's lookup callback, so they must be final here.
    host = normalizeHost(host);
    ip ??= net.isIP(host) ? host : undefined;
    if (matches(this.deny, host, ip))
      return `Host "${host}"${ip ? ` (${ip})` : ""} is blocked by PROXY_DENY_HOSTS`;
    if (!this.allow.empty && !matches(this.allow, host, ip)) {
      // Before DNS resolution we only know the name; IP-based allow rules are re-checked after lookup.
      if (ip === undefined && this.allow.hasBlocks) return null;
      return `Host "${host}"${ip ? ` (${ip})` : ""} is not in PROXY_ALLOW_HOSTS`;
    }
    return null;
  }

  assert(host: string, ip?: string): void {
    const reason = this.check(host, ip);
    if (reason) throw new HostPolicyError(reason);
  }
}

/** A policy that allows everything (used by tests and the CLI by default). */
export const OPEN_POLICY = new HostPolicy();
