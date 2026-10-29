/**
 * Optional single-user authentication.
 *
 *   POSTBOX_PASSWORD  enables the /login form; a signed, HTTP-only session cookie is issued.
 *   POSTBOX_TOKEN     enables `Authorization: Bearer <token>` for API, automation and MCP clients
 *                     (it is also accepted on the login form).
 *
 * With neither set, Postbox stays open (trusted LAN use). Enforcement lives in src/proxy.ts.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "postbox_session";

export interface AuthConfig {
  password: string | null;
  token: string | null;
  secret: Buffer;
  sessionTtlMs: number;
}

export function getAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig | null {
  const password = env.POSTBOX_PASSWORD || null;
  const token = env.POSTBOX_TOKEN || null;
  if (!password && !token) return null;
  // Deriving from the credentials means changing them invalidates existing sessions.
  const secret = env.POSTBOX_SESSION_SECRET
    ? createHash("sha256").update(env.POSTBOX_SESSION_SECRET).digest()
    : createHash("sha256")
        .update(`postbox-session\0${password ?? ""}\0${token ?? ""}`)
        .digest();
  const days = Number(env.POSTBOX_SESSION_DAYS) || 30;
  return { password, token, secret, sessionTtlMs: days * 86_400_000 };
}

/** Constant-time string comparison (hashing first equalises lengths). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

const sign = (cfg: AuthConfig, payload: string) =>
  createHmac("sha256", cfg.secret).update(payload).digest("base64url");

/** Session cookie value: `v1.<expiresAtMs>.<hmac>`. */
export function createSession(cfg: AuthConfig, now = Date.now()): { value: string; expires: Date } {
  const exp = now + cfg.sessionTtlMs;
  const payload = `v1.${exp}`;
  return { value: `${payload}.${sign(cfg, payload)}`, expires: new Date(exp) };
}

export function verifySession(cfg: AuthConfig, value: string | undefined | null, now = Date.now()): boolean {
  if (!value) return false;
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return false;
  const exp = Number(parts[1]);
  if (!Number.isFinite(exp) || exp <= now) return false;
  return safeEqual(parts[2], sign(cfg, `${parts[0]}.${parts[1]}`));
}

export function verifyBearer(cfg: AuthConfig, header: string | null): boolean {
  if (!cfg.token || !header) return false;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return !!m && safeEqual(m[1].trim(), cfg.token);
}

/** Password (or token) accepted by the login form. */
export function verifyLoginSecret(cfg: AuthConfig, secret: string): boolean {
  let ok = false;
  // Evaluate both comparisons so timing does not reveal which credential is configured.
  if (cfg.password) ok = safeEqual(secret, cfg.password) || ok;
  if (cfg.token) ok = safeEqual(secret, cfg.token) || ok;
  return ok;
}

/** Routes reachable without authentication. */
export function isPublicPath(pathname: string): boolean {
  return (
    pathname === "/login" ||
    pathname === "/api/health" ||
    pathname.startsWith("/api/auth/") ||
    pathname.startsWith("/_next/") ||
    pathname === "/favicon.ico"
  );
}

// ------------------------------------------------------------------ login rate limiting

const attempts = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 5 * 60_000;

/** Returns false when the client has exceeded the failed-login budget. */
export function loginAllowed(key: string, now = Date.now()): boolean {
  const a = attempts.get(key);
  if (!a || a.resetAt <= now) return true;
  return a.count < MAX_ATTEMPTS;
}

export function recordLoginFailure(key: string, now = Date.now()) {
  const a = attempts.get(key);
  if (!a || a.resetAt <= now) attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
  else a.count++;
  if (attempts.size > 10_000) for (const [k, v] of attempts) if (v.resetAt <= now) attempts.delete(k);
}

export function clearLoginFailures(key: string) {
  attempts.delete(key);
}

export function clientKey(headers: Headers): string {
  return headers.get("x-forwarded-for")?.split(",")[0].trim() || headers.get("x-real-ip") || "local";
}
