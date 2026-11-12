/**
 * Authentication primitives (no database access; see caller.ts for identity resolution).
 *
 *   POSTBOX_PASSWORD  single-user login until the first account exists (session cookie v1).
 *   POSTBOX_TOKEN     `Authorization: Bearer <token>` acting as the bootstrap/recovery admin.
 *   accounts          username + password login (session cookie v2 carrying the user id) and
 *                     personal API tokens.
 *
 * With no credentials and no accounts, Postbox stays open (trusted LAN use).
 * Enforcement lives in src/proxy.ts.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "postbox_session";

export interface AuthConfig {
  password: string | null;
  token: string | null;
  secret: Buffer;
  sessionTtlMs: number;
}

export const sessionTtlMs = (env: NodeJS.ProcessEnv = process.env) =>
  (Number(env.POSTBOX_SESSION_DAYS) || 30) * 86_400_000;

export function getAuthConfig(
  env: NodeJS.ProcessEnv = process.env,
  opts: { epoch?: string; sessionTtlMs?: number } = {},
): AuthConfig | null {
  const password = env.POSTBOX_PASSWORD || null;
  const token = env.POSTBOX_TOKEN || null;
  if (!password && !token) return null;
  // Deriving from the credentials means changing them invalidates existing sessions.
  // The epoch is rotated by "sign out all sessions".
  const epoch = opts.epoch ? `\0${opts.epoch}` : "";
  const secret = env.POSTBOX_SESSION_SECRET
    ? createHash("sha256").update(`${env.POSTBOX_SESSION_SECRET}${epoch}`).digest()
    : createHash("sha256")
        .update(`postbox-session\0${password ?? ""}\0${token ?? ""}${epoch}`)
        .digest();
  return { password, token, secret, sessionTtlMs: opts.sessionTtlMs ?? sessionTtlMs(env) };
}

/** Constant-time string comparison (hashing first equalises lengths). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

const mac = (secret: Buffer, payload: string) =>
  createHmac("sha256", secret).update(payload).digest("base64url");
const sign = (cfg: AuthConfig, payload: string) => mac(cfg.secret, payload);

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

/** Account session cookie: `v2.<userId>.<sessionVersion>.<expiresAtMs>.<hmac>`. */
export function createUserSession(
  secret: Buffer,
  user: { id: string; sessionVersion: number },
  ttlMs: number,
  now = Date.now(),
): { value: string; expires: Date } {
  const exp = now + ttlMs;
  const payload = `v2.${user.id}.${user.sessionVersion}.${exp}`;
  return { value: `${payload}.${mac(secret, payload)}`, expires: new Date(exp) };
}

/** Returns the signed user id and session version, or null for anything forged, expired or not v2. */
export function parseUserSession(
  secret: Buffer,
  value: string | undefined | null,
  now = Date.now(),
): { userId: string; sessionVersion: number } | null {
  const parts = value?.split(".") ?? [];
  if (parts.length !== 5 || parts[0] !== "v2") return null;
  const [, userId, version, expRaw, sig] = parts;
  const exp = Number(expRaw);
  if (!userId || !Number.isFinite(exp) || exp <= now) return null;
  if (!safeEqual(sig, mac(secret, parts.slice(0, 4).join(".")))) return null;
  return { userId, sessionVersion: Number(version) };
}

/** Bearer value from an Authorization header. */
export function bearerToken(header: string | null): string | null {
  const m = header ? /^Bearer\s+(.+)$/i.exec(header.trim()) : null;
  return m ? m[1].trim() : null;
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
    /^\/api\/catalog(?:\/[a-zA-Z0-9_-]+)?$/.test(pathname) ||
    /^\/api\/documentation\/[a-zA-Z0-9_-]+$/.test(pathname) ||
    /^\/api\/telemetry\/ingest\/[a-zA-Z0-9_-]+\/v1\/traces$/.test(pathname) ||
    /^\/api\/runner-agent\/[a-z]+(?:\/[a-zA-Z0-9_-]+\/[a-z]+)?$/.test(pathname) ||
    pathname.startsWith("/mock/") ||
    pathname.startsWith("/hook/") ||
    pathname.startsWith("/capture/") ||
    pathname === "/login" ||
    pathname === "/invite" ||
    pathname === "/api/health" ||
    pathname.startsWith("/api/auth/") ||
    pathname.startsWith("/_next/") ||
    pathname === "/favicon.ico"
  );
}

// ------------------------------------------------------------------ login rate limiting

/**
 * Failed-attempt budgets, by key kind (the part of the key before the first ":").
 *
 * - `client`: one client address, any credential.
 * - `pair`: one account from one client address, so nobody else can lock that account out.
 * - `account`: one account from anywhere; a high ceiling against guessing from many addresses.
 * - `secret`: the single-user POSTBOX_PASSWORD / POSTBOX_TOKEN from anywhere, so rotating
 *   addresses gains nothing.
 */
export const LOGIN_LIMITS = {
  client: { max: 10, windowMs: 5 * 60_000 },
  invite: { max: 10, windowMs: 5 * 60_000 },
  pair: { max: 10, windowMs: 5 * 60_000 },
  account: { max: 100, windowMs: 15 * 60_000 },
  secret: { max: 100, windowMs: 15 * 60_000 },
} as const;
type LimitKind = keyof typeof LOGIN_LIMITS;

export const loginKeys = {
  client: (address: string) => `client:${address}`,
  invite: (address: string) => `invite:${address}`,
  pair: (username: string, address: string) => `pair:${username}\0${address}`,
  account: (username: string) => `account:${username}`,
  secret: () => "secret:",
};

// Shared through globalThis: the request gate and the route handlers can be separate bundles.
const STORE = "__postboxLoginAttempts";
const attempts: Map<string, { count: number; resetAt: number }> = ((
  globalThis as { [STORE]?: Map<string, { count: number; resetAt: number }> }
)[STORE] ??= new Map());

function limitOf(key: string) {
  const kind = key.slice(0, key.indexOf(":")) as LimitKind;
  return LOGIN_LIMITS[kind] ?? LOGIN_LIMITS.client;
}

/** Returns false when the key has used up its failed-attempt budget. */
export function loginAllowed(key: string, now = Date.now()): boolean {
  const a = attempts.get(key);
  if (!a || a.resetAt <= now) return true;
  return a.count < limitOf(key).max;
}

export function recordLoginFailure(key: string, now = Date.now()) {
  const a = attempts.get(key);
  if (!a || a.resetAt <= now) attempts.set(key, { count: 1, resetAt: now + limitOf(key).windowMs });
  else a.count++;
  if (attempts.size > 10_000) for (const [k, v] of attempts) if (v.resetAt <= now) attempts.delete(k);
}

export function clearLoginFailures(key: string) {
  attempts.delete(key);
}

/** Forget every counter (tests). */
export function resetLoginFailures() {
  attempts.clear();
}

/** Longest login or invite body accepted; passwords are capped at 1024 characters anyway. */
export const LOGIN_BODY_LIMIT = 8 * 1024;
export const MAX_PASSWORD_LENGTH = 1024;
