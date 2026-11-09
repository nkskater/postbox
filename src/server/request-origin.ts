/**
 * Cross-site request forgery guard for browser requests that rely on the session cookie.
 *
 * SameSite=Lax cookies are still sent to same-site origins, and on a LAN every other
 * service on the same host or IP (any port) is same-site. Unsafe requests are therefore
 * only accepted from the Postbox origin itself. Requests with an Authorization header
 * cannot be forged by another origin (that header needs a CORS preflight Postbox never
 * grants), and clients without an Origin header (CLI, curl, servers) are not browsers.
 */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const firstValue = (value: string | null) => value?.split(",")[0].trim() || null;

/** Host the client addressed, as seen through a reverse proxy when one forwards it. */
export function requestHost(headers: Headers, url: string | URL): string {
  return firstValue(headers.get("x-forwarded-host")) ?? headers.get("host") ?? new URL(url).host;
}

/** Extra origins trusted like Postbox's own (POSTBOX_ALLOWED_ORIGINS, comma-separated). */
export function allowedOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.POSTBOX_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim().replace(/\/$/, "").toLowerCase())
    .filter(Boolean);
}

/** True when a browser on another origin sent this state-changing request. */
export function isCrossOriginWrite(
  method: string,
  headers: Headers,
  url: string | URL,
  extraOrigins = allowedOrigins(),
): boolean {
  if (SAFE_METHODS.has(method.toUpperCase())) return false;
  if (headers.get("authorization")) return false;
  const site = headers.get("sec-fetch-site");
  if (site === "same-origin" || site === "none") return false;
  const origin = headers.get("origin");
  if (origin && extraOrigins.includes(origin.replace(/\/$/, "").toLowerCase())) return false;
  if (site === "cross-site" || site === "same-site") return true;
  if (!origin) return false;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    // "null" (sandboxed frames, file: pages) and anything unparsable.
    return true;
  }
  return originHost.toLowerCase() !== requestHost(headers, url).toLowerCase();
}
