/**
 * Outbound network configuration: an HTTP(S) proxy and per-host TLS identities.
 *
 * Proxy: http:// or https:// proxy URL with optional Basic credentials and a bypass list
 * (same pattern syntax as PROXY_ALLOW_HOSTS). Plain http targets are sent to the proxy in
 * absolute form; https, WebSocket and Socket.IO targets go through a CONNECT tunnel and
 * TLS is negotiated end to end with the target. The proxy endpoint itself is trusted: an
 * administrator configures it, so it is not subject to PROXY_ALLOW_HOSTS / PROXY_DENY_HOSTS.
 * Targets are, by name (see HostPolicy.checkTarget), because the proxy resolves them.
 *
 * TLS profiles: a custom CA (added to the system roots), and a client certificate + key
 * (mTLS), selected by host pattern (`host`, `*.domain`, or `host:port`).
 */
import crypto from "node:crypto";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { HostPatternSet, type HostPolicy } from "./policy";

export class OutboundConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutboundConfigError";
  }
}

export interface ProxySettings {
  url: string;
  username?: string;
  password?: string;
  bypass?: string[];
}

export interface TlsIdentity {
  /** PEM bundle added to the system root certificates. */
  ca?: string;
  /** PEM client certificate (chain) and private key for mutual TLS. */
  cert?: string;
  key?: string;
  passphrase?: string;
}

export interface TlsProfile extends TlsIdentity {
  id: string;
  name: string;
  /** `host`, `*.domain` or `host:port`. */
  hosts: string[];
}

export interface ParsedProxy {
  secure: boolean;
  host: string;
  port: number;
  /** Proxy-Authorization header value, when credentials are set. */
  authorization?: string;
  /** For display: scheme://host:port */
  label: string;
}

const PEM_BLOCK = /-----BEGIN ([A-Z0-9 ]+)-----[\s\S]+?-----END \1-----/g;

/** Validate and normalize a proxy URL. Credentials belong in the separate fields. */
export function parseProxyUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new OutboundConfigError(`Invalid proxy URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new OutboundConfigError("Only http:// and https:// proxies are supported (SOCKS is not)");
  if (url.username || url.password)
    throw new OutboundConfigError("Put the proxy username and password in their own fields, not the URL");
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash)
    throw new OutboundConfigError("The proxy URL must be scheme://host[:port] only");
  if (!url.hostname) throw new OutboundConfigError("The proxy URL has no host");
  return url;
}

function parseProxy(settings: ProxySettings): ParsedProxy {
  const url = parseProxyUrl(settings.url);
  const secure = url.protocol === "https:";
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const port = Number(url.port) || (secure ? 443 : 80);
  const authorization =
    settings.username || settings.password
      ? `Basic ${Buffer.from(`${settings.username ?? ""}:${settings.password ?? ""}`).toString("base64")}`
      : undefined;
  return { secure, host, port, authorization, label: `${url.protocol}//${url.host}` };
}

/** Split `host`, `host:port` or `[v6]:port` into its parts. */
function splitHostPort(pattern: string): { host: string; port?: number } {
  const p = pattern.trim().toLowerCase();
  const bracket = /^(\[[^\]]+\]):(\d{1,5})$/.exec(p);
  if (bracket) return { host: bracket[1], port: Number(bracket[2]) };
  if (!p.startsWith("[") && p.split(":").length === 2) {
    const [host, port] = p.split(":");
    if (/^\d{1,5}$/.test(port)) return { host, port: Number(port) };
  }
  return { host: p };
}

interface CompiledProfile {
  profile: TlsProfile;
  entries: { hosts: HostPatternSet; port?: number; exact: boolean }[];
}

/** Parse one PEM certificate bundle; throws when it holds no valid certificate. */
export function parseCertificates(pem: string, label: string): crypto.X509Certificate[] {
  const blocks = (pem.match(PEM_BLOCK) ?? []).filter((b) => /BEGIN CERTIFICATE/.test(b));
  if (blocks.length === 0) throw new OutboundConfigError(`${label} must be a PEM certificate`);
  return blocks.map((b) => {
    try {
      return new crypto.X509Certificate(b);
    } catch {
      throw new OutboundConfigError(`${label} contains a certificate that cannot be parsed`);
    }
  });
}

/** Validate a TLS profile's PEM material. Throws OutboundConfigError with a precise message. */
export function validateIdentity(identity: TlsIdentity): void {
  if (identity.ca) parseCertificates(identity.ca, "The CA certificate");
  if (identity.cert || identity.key) {
    if (!identity.cert || !identity.key)
      throw new OutboundConfigError("A client certificate and its private key must be provided together");
    const [leaf] = parseCertificates(identity.cert, "The client certificate");
    let key: crypto.KeyObject;
    if (/ENCRYPTED/.test(identity.key) && !identity.passphrase)
      throw new OutboundConfigError("The private key is encrypted and the passphrase is missing or wrong");
    try {
      key = crypto.createPrivateKey({ key: identity.key, passphrase: identity.passphrase });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      throw new OutboundConfigError(
        code === "ERR_OSSL_BAD_DECRYPT" || /passphrase|decrypt/i.test((err as Error).message)
          ? "The private key is encrypted and the passphrase is missing or wrong"
          : "The private key is not a valid PEM key",
      );
    }
    if (!leaf.checkPrivateKey(key))
      throw new OutboundConfigError("The private key does not match the client certificate");
  }
}

export class OutboundNetwork {
  readonly proxy: ParsedProxy | null;
  private bypass: HostPatternSet;
  private bypassPatterns: string[];
  private profiles: CompiledProfile[];

  constructor(opts: { proxy?: ProxySettings | null; profiles?: TlsProfile[] } = {}) {
    this.proxy = opts.proxy?.url ? parseProxy(opts.proxy) : null;
    this.bypassPatterns = (opts.proxy?.bypass ?? []).map((p) => p.trim()).filter(Boolean);
    this.bypass = new HostPatternSet(opts.proxy?.bypass ?? [], "proxy bypass list");
    this.profiles = (opts.profiles ?? []).map((profile) => ({
      profile,
      entries: profile.hosts.map((raw) => {
        const { host, port } = splitHostPort(raw);
        return {
          hosts: new HostPatternSet([host], `TLS profile "${profile.name}"`),
          port,
          exact: !host.startsWith("*"),
        };
      }),
    }));
  }

  /** The proxy to use for a target, or null for a direct connection. */
  proxyForHost(hostname: string, _port?: number): ParsedProxy | null {
    if (!this.proxy) return null;
    const host = hostname.replace(/^\[|\]$/g, "");
    if (this.bypass.matches(host)) return null;
    return this.proxy;
  }

  proxyFor(url: URL): ParsedProxy | null {
    const port = Number(url.port) || (url.protocol === "https:" || url.protocol === "wss:" ? 443 : 80);
    return this.proxyForHost(url.hostname, port);
  }

  /** The most specific matching TLS profile: host and port, then exact host, then wildcard. */
  tlsFor(hostname: string, port: number): TlsIdentity | undefined {
    const host = hostname.replace(/^\[|\]$/g, "");
    let best: { score: number; profile: TlsProfile } | undefined;
    for (const { profile, entries } of this.profiles) {
      for (const e of entries) {
        if (!e.hosts.matches(host)) continue;
        if (e.port !== undefined && e.port !== port) continue;
        const score = (e.port !== undefined ? 2 : 0) + (e.exact ? 1 : 0);
        if (!best || score > best.score) best = { score, profile };
      }
    }
    return best?.profile;
  }

  /** Read-only summary with secrets removed. */
  describe(): {
    proxy: { url: string; authenticated: boolean; bypass: string[] } | null;
    profiles: { id: string; name: string; hosts: string[]; ca: boolean; clientCertificate: boolean }[];
  } {
    return {
      proxy: this.proxy
        ? { url: this.proxy.label, authenticated: !!this.proxy.authorization, bypass: this.bypassPatterns }
        : null,
      profiles: this.profiles.map(({ profile }) => ({
        id: profile.id,
        name: profile.name,
        hosts: profile.hosts,
        ca: !!profile.ca,
        clientCertificate: !!profile.cert,
      })),
    };
  }
}

/** Node TLS options for an identity: custom CAs extend the system roots. */
export function tlsOptions(identity?: TlsIdentity): {
  ca?: string[];
  cert?: string;
  key?: string;
  passphrase?: string;
} {
  if (!identity) return {};
  return {
    ...(identity.ca ? { ca: [...tls.rootCertificates, identity.ca] } : {}),
    ...(identity.cert && identity.key
      ? {
          cert: identity.cert,
          key: identity.key,
          ...(identity.passphrase ? { passphrase: identity.passphrase } : {}),
        }
      : {}),
  };
}

export interface TunnelOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  verifySsl?: boolean;
  /** Identity for the proxy's own TLS (https:// proxies). */
  proxyIdentity?: TlsIdentity;
}

export class ProxyError extends Error {
  constructor(
    message: string,
    public code: string,
  ) {
    super(message);
    this.name = "ProxyError";
  }
}

const MAX_CONNECT_RESPONSE = 16 * 1024;

/**
 * Open a CONNECT tunnel through the proxy to host:port. Resolves with the raw socket once
 * the proxy answers 2xx. The proxy address is resolved normally (it is trusted).
 */
export function openProxyTunnel(
  proxy: ParsedProxy,
  host: string,
  port: number,
  opts: TunnelOptions,
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    let done = false;
    const target = net.isIPv6(host) ? `[${host}]:${port}` : `${host}:${port}`;
    const sock: net.Socket = proxy.secure
      ? tls.connect({
          host: proxy.host,
          port: proxy.port,
          servername: net.isIP(proxy.host) ? undefined : proxy.host,
          rejectUnauthorized: opts.verifySsl ?? true,
          ...tlsOptions(opts.proxyIdentity),
        })
      : net.connect({ host: proxy.host, port: proxy.port });

    const settle = (err: Error | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      sock.removeListener("data", onData);
      sock.removeListener("error", onError);
      sock.removeListener("close", onClose);
      if (err) {
        sock.destroy();
        reject(err);
      } else {
        sock.setTimeout(0);
        resolve(sock);
      }
    };
    const timer = setTimeout(
      () => settle(new ProxyError(`Proxy did not answer within ${opts.timeoutMs} ms`, "ETIMEDOUT")),
      opts.timeoutMs,
    );
    const onAbort = () => settle(new ProxyError("Request was cancelled", "ECANCELLED"));
    const onError = (err: Error) => {
      const code = (err as NodeJS.ErrnoException).code ?? "EPROXY";
      settle(new ProxyError(`Could not reach proxy ${proxy.label}: ${err.message || code}`, "EPROXY"));
    };
    const onClose = () => settle(new ProxyError(`Proxy ${proxy.label} closed the connection`, "EPROXY"));
    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf("\r\n\r\n");
      if (end < 0) {
        if (buffered.length > MAX_CONNECT_RESPONSE)
          settle(new ProxyError("Proxy sent an oversized response", "EPROXY"));
        return;
      }
      const statusLine = buffered.subarray(0, buffered.indexOf("\r\n")).toString("latin1");
      const match = /^HTTP\/1\.[01] (\d{3})/.exec(statusLine);
      const status = match ? Number(match[1]) : 0;
      if (status < 200 || status >= 300) {
        if (status === 407)
          return settle(
            new ProxyError("Proxy authentication failed (407). Check the proxy credentials.", "EPROXYAUTH"),
          );
        return settle(
          new ProxyError(
            status
              ? `Proxy refused to connect to ${target} (HTTP ${status})`
              : "Proxy sent an invalid response",
            "EPROXYDENIED",
          ),
        );
      }
      const rest = buffered.subarray(end + 4);
      if (rest.length) sock.unshift(rest);
      settle(null);
    };
    sock.on("data", onData);
    sock.on("error", onError);
    sock.on("close", onClose);
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.signal?.aborted) return onAbort();

    const send = () => {
      const lines = [`CONNECT ${target} HTTP/1.1`, `Host: ${target}`];
      if (proxy.authorization) lines.push(`Proxy-Authorization: ${proxy.authorization}`);
      sock.write(lines.join("\r\n") + "\r\n\r\n");
    };
    if (proxy.secure) sock.once("secureConnect", send);
    else sock.once("connect", send);
  });
}

export interface ConnectionContext {
  policy: HostPolicy;
  /** DNS hook that applies the host policy to resolved addresses (direct connections only). */
  lookup: net.LookupFunction;
  verifySsl: boolean;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface ConnectionPlan {
  /** Use the https module (TLS to the target, or to an https proxy for plain targets). */
  secure: boolean;
  options: https.RequestOptions;
  /** Headers to add to the request (Proxy-Authorization). */
  headers: [string, string][];
  /** Request path to send: absolute-form when a plain http target goes through a proxy. */
  path: string;
  proxied: boolean;
}

/** TLS connection to the target over an established tunnel (or a fresh socket). */
function connectTls(
  socket: net.Socket | undefined,
  url: URL,
  verifySsl: boolean,
  identity: TlsIdentity | undefined,
  extra: tls.ConnectionOptions = {},
): tls.TLSSocket {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  return tls.connect({
    ...(socket ? { socket } : {}),
    servername: net.isIP(host) ? undefined : host,
    rejectUnauthorized: verifySsl,
    ...tlsOptions(identity),
    ...extra,
  });
}

function defaultPort(url: URL): number {
  return Number(url.port) || (url.protocol === "https:" || url.protocol === "wss:" ? 443 : 80);
}

/**
 * Decide how to reach a target for a request made with node:http / node:https, honoring the
 * proxy and the target's TLS profile. The caller has already passed the host policy check.
 */
export function planConnection(url: URL, ctx: ConnectionContext, path: string): ConnectionPlan {
  const network = ctx.policy.network;
  const isHttps = url.protocol === "https:";
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const port = defaultPort(url);
  const proxy = network?.proxyFor(url) ?? null;
  const identity = network?.tlsFor(host, port);

  if (!proxy) {
    return {
      secure: isHttps,
      proxied: false,
      path,
      headers: [],
      options: {
        hostname: host,
        port,
        lookup: ctx.lookup,
        rejectUnauthorized: ctx.verifySsl,
        servername: net.isIP(host) ? undefined : host,
        ...tlsOptions(identity),
      },
    };
  }

  const headers: [string, string][] = [];
  if (!isHttps) {
    // Plain target: ask the proxy to forward it. The proxy's own address is not policy-checked.
    if (proxy.authorization) headers.push(["Proxy-Authorization", proxy.authorization]);
    const proxyIdentity = network?.tlsFor(proxy.host, proxy.port);
    const absolute = new URL(url.href);
    absolute.hash = "";
    return {
      secure: proxy.secure,
      proxied: true,
      headers,
      path: absolute.href,
      options: {
        hostname: proxy.host,
        port: proxy.port,
        lookup: dns.lookup as net.LookupFunction,
        ...(proxy.secure
          ? {
              rejectUnauthorized: ctx.verifySsl,
              servername: net.isIP(proxy.host) ? undefined : proxy.host,
              ...tlsOptions(proxyIdentity),
            }
          : {}),
      },
    };
  }

  const proxyIdentity = network?.tlsFor(proxy.host, proxy.port);
  return {
    secure: true,
    proxied: true,
    headers,
    path,
    options: {
      hostname: host,
      port,
      createConnection: ((_opts: unknown, cb: (err: Error | null, socket?: net.Socket) => void) => {
        openProxyTunnel(proxy, host, port, {
          timeoutMs: ctx.timeoutMs,
          signal: ctx.signal,
          verifySsl: ctx.verifySsl,
          proxyIdentity,
        }).then(
          (tunnel) => {
            const secure = connectTls(tunnel, url, ctx.verifySsl, identity);
            secure.once("error", () => tunnel.destroy());
            cb(null, secure);
          },
          (err) => cb(err),
        );
      }) as unknown as https.RequestOptions["createConnection"],
    },
  };
}

/** Failures from the proxy surface as ordinary request errors with their own codes. */
export function isProxyError(err: unknown): err is ProxyError {
  return err instanceof ProxyError;
}

/**
 * An agent for libraries that take one (ws, socket.io). Direct connections get the DNS policy
 * hook and the target's TLS profile; proxied ones tunnel with CONNECT (also for ws://).
 */
export function createOutboundAgent(url: URL, ctx: ConnectionContext): http.Agent | https.Agent {
  const network = ctx.policy.network;
  const secureTarget = url.protocol === "https:" || url.protocol === "wss:";
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const port = defaultPort(url);
  const proxy = network?.proxyFor(url) ?? null;
  const identity = network?.tlsFor(host, port);

  if (!proxy) {
    return secureTarget
      ? new https.Agent({
          lookup: ctx.lookup,
          rejectUnauthorized: ctx.verifySsl,
          ...tlsOptions(identity),
        } as https.AgentOptions)
      : new http.Agent({ lookup: ctx.lookup } as http.AgentOptions);
  }

  const proxyIdentity = network?.tlsFor(proxy.host, proxy.port);
  const agent = secureTarget ? new https.Agent() : new http.Agent();
  (agent as unknown as { createConnection: unknown }).createConnection = (
    _opts: unknown,
    cb: (err: Error | null, socket?: net.Socket) => void,
  ) => {
    openProxyTunnel(proxy, host, port, {
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
      verifySsl: ctx.verifySsl,
      proxyIdentity,
    }).then(
      (tunnel) => {
        if (!secureTarget) return cb(null, tunnel);
        const secure = connectTls(tunnel, url, ctx.verifySsl, identity);
        secure.once("error", () => tunnel.destroy());
        cb(null, secure);
      },
      (err) => cb(err),
    );
  };
  return agent;
}
