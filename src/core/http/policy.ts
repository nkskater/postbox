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
 */
import net from "node:net";

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

function compile(patterns: string[]): CompiledRules {
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
    if (!p) continue;
    if (p === "*") rules.any = true;
    else if (p.startsWith("*.")) rules.wildcards.push(p.slice(1));
    else if (p.includes("/")) {
      const [addr, prefix] = p.split("/");
      const family = net.isIPv6(addr) ? "ipv6" : "ipv4";
      if (net.isIP(addr)) {
        rules.blocks.addSubnet(addr, Number(prefix), family);
        rules.hasBlocks = true;
      }
    } else if (net.isIP(p)) {
      rules.blocks.addAddress(p, net.isIPv6(p) ? "ipv6" : "ipv4");
      rules.hasBlocks = true;
    } else rules.names.push(p);
  }
  rules.empty = !rules.any && !rules.names.length && !rules.wildcards.length && !rules.hasBlocks;
  return rules;
}

function matches(rules: CompiledRules, host: string, ip?: string): boolean {
  if (rules.any) return true;
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (rules.names.includes(h)) return true;
  if (rules.wildcards.some((w) => h.endsWith(w) && h.length > w.length)) return true;
  if (rules.hasBlocks) {
    for (const addr of [h, ip]) {
      if (addr && net.isIP(addr) && rules.blocks.check(addr, net.isIPv6(addr) ? "ipv6" : "ipv4")) return true;
    }
  }
  return false;
}

export class HostPolicy {
  private allow: CompiledRules;
  private deny: CompiledRules;

  constructor(allow: string[] = [], deny: string[] = []) {
    this.allow = compile(allow);
    this.deny = compile(deny);
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): HostPolicy {
    const split = (v?: string) =>
      v
        ? v
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
    return new HostPolicy(split(env.PROXY_ALLOW_HOSTS), split(env.PROXY_DENY_HOSTS));
  }

  /** Returns null when allowed, or a reason string when blocked. */
  check(host: string, ip?: string): string | null {
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
