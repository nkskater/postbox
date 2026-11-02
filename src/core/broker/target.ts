/**
 * Where a brokered call may go. The consumer supplies only a path (and query) under the registered API's base URL;
 * it can never choose the host, so a stored credential cannot be steered to another destination.
 */
export class TargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TargetError";
  }
}

export const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;
export type BrokerMethod = (typeof METHODS)[number];

/** A registered base URL: http(s), a host, no credentials, query or fragment. */
export function parseBaseUrl(text: string): URL {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new TargetError("The base URL is not a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new TargetError("The base URL must use http or https");
  if (url.username || url.password)
    throw new TargetError("The base URL must not contain credentials; the broker injects them");
  if (url.search || url.hash) throw new TargetError("The base URL must not contain a query or fragment");
  return url;
}

/** Normalised prefix of path segments: "/v1/", "/v1" and "v1" all become "/v1". */
export function normalizePrefix(prefix: string): string {
  const trimmed = prefix.trim();
  if (!trimmed || trimmed === "/") return "/";
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withSlash.replace(/\/+$/, "");
}

const decodeAll = (text: string) => {
  let current = text;
  for (let i = 0; i < 3; i++) {
    try {
      const next = decodeURIComponent(current);
      if (next === current) break;
      current = next;
    } catch {
      break;
    }
  }
  return current;
};

/**
 * The full URL for a call. `path` must start with "/" and stay inside the base URL's path: no authority, no
 * backslashes, no dot segments (also when percent-encoded), no control characters.
 */
export function buildTarget(base: URL, path: string): { url: string; path: string } {
  if (!path.startsWith("/") || path.startsWith("//"))
    throw new TargetError("The path must start with a single '/' and be relative to the API's base URL");
  if (/[\u0000-\u001f\u007f\\]/.test(path)) throw new TargetError("The path contains forbidden characters");
  const [pathOnly, ...queryParts] = path.split("?");
  const query = queryParts.join("?");
  if (query.includes("#") || pathOnly.includes("#")) throw new TargetError("A fragment is not allowed");
  const decoded = decodeAll(pathOnly);
  if (decoded.includes("\\") || decoded.split("/").some((s) => s === ".." || s === "."))
    throw new TargetError("Dot segments are not allowed in the path");
  const prefix = base.pathname.replace(/\/+$/, "");
  const url = `${base.origin}${prefix}${pathOnly}${query ? `?${query}` : ""}`;
  // Parsing must agree with what we built: same origin, still under the base path.
  const parsed = new URL(url);
  if (
    parsed.origin !== base.origin ||
    !(parsed.pathname === prefix || parsed.pathname.startsWith(`${prefix}/`))
  )
    throw new TargetError("The path leaves the API's base URL");
  return { url: parsed.toString(), path: pathOnly };
}

/** Does `path` fall under one of the prefixes? An empty list allows everything under the base URL. */
export function pathAllowed(prefixes: readonly string[], path: string): boolean {
  if (!prefixes.length) return true;
  const target = decodeAll(path);
  // Never trust a prefix match on a path that could climb out of it.
  if (target.split("/").some((s) => s === ".." || s === ".")) return false;
  return prefixes.some((raw) => {
    const prefix = normalizePrefix(raw);
    return prefix === "/" || target === prefix || target.startsWith(`${prefix}/`);
  });
}
