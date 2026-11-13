/**
 * The address a request really came from, for limits that must not trust the client.
 *
 * Next.js only fills in `X-Forwarded-For` when the client did not send one, so a route handler
 * cannot tell a forged header from the socket address. At start-up the server installs a hook on
 * the Node HTTP server that records the socket address (or, behind trusted proxies, the address
 * those proxies reported) in `CLIENT_ADDRESS_HEADER`, replacing anything the client sent there.
 */
import http from "node:http";
import https from "node:https";

export const CLIENT_ADDRESS_HEADER = "x-postbox-client-address";

const INSTALLED = "__postboxClientAddressInstalled";
type Flags = { [INSTALLED]?: boolean };

/**
 * How many reverse proxies in front of Postbox append to `X-Forwarded-For` (POSTBOX_TRUSTED_PROXIES).
 * 0, the default, ignores forwarding headers entirely.
 */
export function trustedProxyCount(env: Record<string, string | undefined> = process.env): number {
  const n = Number.parseInt(env.POSTBOX_TRUSTED_PROXIES ?? "", 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 10) : 0;
}

/**
 * The client of a request: the socket address, or with `trusted` proxies in front, the entry
 * those proxies added to `X-Forwarded-For` (the `trusted`-th from the right). Entries further left
 * were written by the client and are ignored.
 */
export function resolveClientAddress(
  socketAddress: string | undefined,
  forwardedFor: string | string[] | undefined,
  trusted: number,
): string {
  const socket = socketAddress || "unknown";
  if (!trusted) return socket;
  const chain = (Array.isArray(forwardedFor) ? forwardedFor.join(",") : (forwardedFor ?? ""))
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  // The nearest proxy is the socket peer; each trusted proxy appended the address it saw.
  return chain[chain.length - trusted] ?? chain[0] ?? socket;
}

/** Set the trusted client address header on an incoming request, overwriting any forged value. */
export function stampClientAddress(req: http.IncomingMessage, trusted = trustedProxyCount()) {
  req.headers[CLIENT_ADDRESS_HEADER] = resolveClientAddress(
    req.socket?.remoteAddress,
    req.headers["x-forwarded-for"],
    trusted,
  );
}

/** Hook every HTTP(S) server in this process so requests carry the trusted address. Idempotent. */
export function installClientAddressHook() {
  const flags = globalThis as Flags;
  if (flags[INSTALLED]) return;
  flags[INSTALLED] = true;
  for (const proto of [http.Server.prototype, https.Server.prototype] as { emit: http.Server["emit"] }[]) {
    const emit = proto.emit;
    proto.emit = function (this: http.Server, event: string | symbol, ...args: unknown[]) {
      if (event === "request") stampClientAddress(args[0] as http.IncomingMessage);
      return (emit as (...params: unknown[]) => boolean).call(this, event, ...args);
    } as http.Server["emit"];
  }
}

/**
 * The client key for throttling. Only the hook's header is trusted; without the hook (tests,
 * unusual hosting) every client shares one bucket, which fails safe for limits.
 */
export function clientAddress(headers: Headers): string {
  if (!(globalThis as Flags)[INSTALLED]) return "unknown";
  return headers.get(CLIENT_ADDRESS_HEADER) || "unknown";
}
