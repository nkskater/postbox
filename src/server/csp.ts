/**
 * Content-Security-Policy for the app's own pages (the UI that holds the session). Applied per
 * request by src/proxy.ts with a fresh nonce; Next.js adds the nonce to its own scripts.
 *
 * Not applied to API routes (JSON, or the documentation and catalog pages that send their own
 * nonce policy) or to the public mock, webhook and capture receivers, which set their own headers.
 */

/** A fresh, unguessable nonce for one response. */
export function newNonce(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64");
}

export function appliesCsp(pathname: string): boolean {
  return !/^\/(?:api|mock|hook|capture|_next)(?:\/|$)/.test(pathname) && pathname !== "/favicon.ico";
}

/**
 * The policy. Styles stay inline-capable (React style attributes and CodeMirror); scripts only
 * from the app itself or with the nonce. Requests the user sends go through the server, so the
 * page itself only talks to its own origin. Frames: the app's own documentation previews, and
 * data:/blob: response previews (which also carry their own stricter policy).
 */
export function appCsp(nonce: string, dev = process.env.NODE_ENV === "development"): string {
  return [
    "default-src 'self'",
    // React needs eval only in development, for its error overlays.
    `script-src 'self' 'nonce-${nonce}'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-src 'self' blob: data:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "frame-ancestors 'self'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}

/** Strict-Transport-Security for responses that went out over HTTPS. */
export const HSTS = "max-age=31536000";
