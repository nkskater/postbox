/**
 * Local user accounts and personal API tokens.
 *
 * Passwords are hashed with scrypt; API tokens are random, shown once and stored
 * as SHA-256 hashes. Bumping a user's session_version invalidates their sessions.
 */
import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { getDb, schema } from "./db";
import type { ApiTokenRow, UserRow } from "./db/schema";
import { BROWSER_SETTING_KEYS } from "@/lib/settings/registry";
import { inArray } from "drizzle-orm";
import { newId } from "./defaults";
import { HttpError } from "./errors";

const { users, apiTokens, serverSecrets } = schema;

// ------------------------------------------------------------------ passwords

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 };
export const MIN_PASSWORD_LENGTH = 8;

function derive(password: string, salt: Buffer, N: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, SCRYPT.keylen, { N, r, p, maxmem: SCRYPT.maxmem }, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );
}

/** `scrypt$<log2 N>$<r>$<p>$<salt>$<hash>` (base64url), so parameters can be raised later. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, SCRYPT.N, SCRYPT.r, SCRYPT.p);
  return [
    "scrypt",
    Math.log2(SCRYPT.N),
    SCRYPT.r,
    SCRYPT.p,
    salt.toString("base64url"),
    key.toString("base64url"),
  ].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, logN, r, p, salt, hash] = stored.split("$");
  if (alg !== "scrypt" || !hash) return false;
  const expected = Buffer.from(hash, "base64url");
  const key = await derive(password, Buffer.from(salt, "base64url"), 2 ** Number(logN), Number(r), Number(p));
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** Spend the same time as a real check when the username does not exist. */
let dummyHash: Promise<string> | null = null;
export async function burnPasswordCheck(password: string) {
  await verifyPassword(password, await (dummyHash ??= hashPassword("postbox-dummy")));
}

export function checkPasswordPolicy(password: string) {
  if (password.length < MIN_PASSWORD_LENGTH)
    throw new HttpError(400, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  if (password.length > 1024) throw new HttpError(400, "Password is too long");
}

// ------------------------------------------------------------------ users

/** User fields that are safe to return to clients. */
export interface PublicUser {
  id: string;
  username: string;
  displayName: string;
  isAdmin: boolean;
  disabled: boolean;
  createdAt: number;
}

export const toPublicUser = (u: UserRow): PublicUser => ({
  id: u.id,
  username: u.username,
  displayName: u.displayName,
  isAdmin: u.isAdmin,
  disabled: u.disabled,
  createdAt: u.createdAt,
});

export const normalizeUsername = (name: string) => name.trim().toLowerCase();
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;

export function countUsers(): number {
  return (
    getDb()
      .select({ n: sql<number>`count(*)` })
      .from(users)
      .get()?.n ?? 0
  );
}

export function getUser(id: string) {
  return getDb().select().from(users).where(eq(users.id, id)).get();
}

export function getUserByUsername(username: string) {
  return getDb()
    .select()
    .from(users)
    .where(eq(users.username, normalizeUsername(username)))
    .get();
}

export function listUsers() {
  return getDb().select().from(users).orderBy(asc(users.createdAt)).all();
}

export async function prepareUser(input: {
  username: string;
  password: string;
  displayName?: string;
  isAdmin?: boolean;
}): Promise<UserRow> {
  const username = normalizeUsername(input.username);
  if (!USERNAME_RE.test(username))
    throw new HttpError(400, "Username must be 2-64 characters: letters, digits, '.', '_' or '-'");
  checkPasswordPolicy(input.password);
  const passwordHash = await hashPassword(input.password);
  if (getUserByUsername(username)) throw new HttpError(409, "That username is taken");
  const now = Date.now();
  const row = {
    id: newId(),
    username,
    displayName: input.displayName?.trim() || username,
    passwordHash,
    isAdmin: input.isAdmin ?? false,
    disabled: false,
    sessionVersion: 1,
    createdAt: now,
    updatedAt: now,
  };
  return row;
}

export type PreparedUser = Awaited<ReturnType<typeof prepareUser>>;
/**
 * Insert a prepared user and their private workspace in one transaction.
 * `firstOnly` (first-run setup) re-checks that no account exists inside that transaction,
 * so concurrent setup requests cannot each create an administrator.
 */
export function insertPreparedUser(row: PreparedUser, opts: { firstOnly?: boolean } = {}): UserRow {
  const now = row.createdAt;
  getDb().transaction((tx) => {
    const first = tx.select({ id: users.id }).from(users).get() === undefined;
    if (opts.firstOnly && !first) throw new HttpError(409, "An account already exists; sign in instead");
    if (getUserByUsername(row.username)) throw new HttpError(409, "That username is taken");
    tx.insert(users).values(row).run();
    if (first && row.isAdmin) {
      const existing = tx.select().from(schema.workspaces).all();
      for (const ws of existing)
        tx.insert(schema.workspaceMembers)
          .values({ workspaceId: ws.id, userId: row.id, role: "owner", createdAt: now })
          .onConflictDoNothing()
          .run();
      tx.update(schema.schedules).set({ createdBy: row.id }).where(isNull(schema.schedules.createdBy)).run();
      const preferences = tx
        .select()
        .from(schema.appSettings)
        .where(inArray(schema.appSettings.key, BROWSER_SETTING_KEYS))
        .all();
      for (const pref of preferences)
        tx.insert(schema.userSettings)
          .values({ ...pref, userId: row.id })
          .run();
      tx.delete(schema.appSettings).where(inArray(schema.appSettings.key, BROWSER_SETTING_KEYS)).run();
    }
    const workspaceId = newId();
    tx.insert(schema.workspaces)
      .values({ id: workspaceId, name: `${row.displayName}'s Workspace`, createdAt: now, updatedAt: now })
      .run();
    tx.insert(schema.workspaceMembers)
      .values({ workspaceId, userId: row.id, role: "owner", createdAt: now })
      .run();
  });
  return row;
}

export async function createUser(input: Parameters<typeof prepareUser>[0]): Promise<UserRow> {
  return insertPreparedUser(await prepareUser(input));
}

export async function updateManagedUser(
  id: string,
  patch: { displayName?: string; disabled?: boolean; isAdmin?: boolean; password?: string },
) {
  if (patch.password !== undefined) checkPasswordPolicy(patch.password);
  const passwordHash = patch.password !== undefined ? await hashPassword(patch.password) : undefined;
  return getDb().transaction((tx) => {
    const existing = getUser(id);
    if (!existing) throw new HttpError(404, "User not found");
    const next = { ...existing, ...patch };
    if (existing.isAdmin && !existing.disabled && (!next.isAdmin || next.disabled)) {
      const admins = tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.isAdmin, true), eq(users.disabled, false)))
        .all();
      if (admins.length <= 1)
        throw new HttpError(409, "Cannot disable or demote the last active administrator");
    }
    tx.update(users)
      .set({
        ...(patch.displayName !== undefined
          ? { displayName: patch.displayName.trim() || existing.username }
          : {}),
        ...(patch.disabled !== undefined ? { disabled: patch.disabled } : {}),
        ...(patch.isAdmin !== undefined ? { isAdmin: patch.isAdmin } : {}),
        ...(passwordHash ? { passwordHash } : {}),
        sessionVersion: existing.sessionVersion + 1,
        updatedAt: Date.now(),
      })
      .where(eq(users.id, id))
      .run();
    return getUser(id)!;
  });
}

export function revokeUserAccess(id: string) {
  const db = getDb();
  db.transaction((tx) => {
    if (!getUser(id)) throw new HttpError(404, "User not found");
    tx.update(users)
      .set({ sessionVersion: sql`${users.sessionVersion} + 1`, updatedAt: Date.now() })
      .where(eq(users.id, id))
      .run();
    revokeAllTokens(id);
  });
}

/** Change the password and end every existing session of the user. */
export async function setPassword(userId: string, password: string) {
  checkPasswordPolicy(password);
  const passwordHash = await hashPassword(password);
  getDb()
    .update(users)
    .set({ passwordHash, sessionVersion: sql`${users.sessionVersion} + 1`, updatedAt: Date.now() })
    .where(eq(users.id, userId))
    .run();
  return getUser(userId)!;
}

/** Disabling ends sessions immediately; tokens stop working while the user is disabled. */
export function setDisabled(userId: string, disabled: boolean) {
  const existing = getUser(userId);
  if (
    disabled &&
    existing?.isAdmin &&
    !existing.disabled &&
    listUsers().filter((u) => u.isAdmin && !u.disabled).length <= 1
  )
    throw new HttpError(409, "Cannot disable the last active administrator");
  getDb()
    .update(users)
    .set({ disabled, sessionVersion: sql`${users.sessionVersion} + 1`, updatedAt: Date.now() })
    .where(eq(users.id, userId))
    .run();
}

// ------------------------------------------------------------------ API tokens

export const TOKEN_PREFIX = "pbx_";
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export interface PublicToken {
  id: string;
  name: string;
  prefix: string;
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number | null;
}

const toPublicToken = (t: ApiTokenRow): PublicToken => ({
  id: t.id,
  name: t.name,
  prefix: t.prefix,
  createdAt: t.createdAt,
  lastUsedAt: t.lastUsedAt,
  expiresAt: t.expiresAt,
});

/** Returns the plaintext token once; only its hash is kept. */
export function createToken(userId: string, name: string, expiresInDays?: number | null) {
  const token = TOKEN_PREFIX + randomBytes(32).toString("base64url");
  const now = Date.now();
  const row: ApiTokenRow = {
    id: newId(),
    userId,
    name: name.trim() || "API token",
    tokenHash: hashToken(token),
    prefix: token.slice(0, TOKEN_PREFIX.length + 6),
    lastUsedAt: null,
    expiresAt: expiresInDays ? now + expiresInDays * 86_400_000 : null,
    revokedAt: null,
    createdAt: now,
  };
  getDb().insert(apiTokens).values(row).run();
  return { token, info: toPublicToken(row) };
}

export function listTokens(userId: string): PublicToken[] {
  return getDb()
    .select()
    .from(apiTokens)
    .where(and(eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt)))
    .orderBy(asc(apiTokens.createdAt))
    .all()
    .map(toPublicToken);
}

export function revokeToken(userId: string, tokenId: string): boolean {
  const res = getDb()
    .update(apiTokens)
    .set({ revokedAt: Date.now() })
    .where(and(eq(apiTokens.id, tokenId), eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt)))
    .run();
  return res.changes > 0;
}

export function revokeAllTokens(userId: string) {
  getDb()
    .update(apiTokens)
    .set({ revokedAt: Date.now() })
    .where(and(eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt)))
    .run();
}

/** Resolve a bearer token to its active user, or null if unknown, revoked, expired or disabled. */
export function resolveToken(token: string, now = Date.now()): UserRow | null {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const db = getDb();
  const row = db
    .select()
    .from(apiTokens)
    .where(eq(apiTokens.tokenHash, hashToken(token)))
    .get();
  if (!row || row.revokedAt || (row.expiresAt && row.expiresAt <= now)) return null;
  const user = getUser(row.userId);
  if (!user || user.disabled) return null;
  // Record usage at most once a minute to avoid a write per request.
  if (!row.lastUsedAt || now - row.lastUsedAt > 60_000)
    db.update(apiTokens).set({ lastUsedAt: now }).where(eq(apiTokens.id, row.id)).run();
  return user;
}

// ------------------------------------------------------------------ server secrets

/** Random secret generated on first use and kept in the database. */
export function storedSecret(key: string): Buffer {
  const db = getDb();
  const existing = db.select().from(serverSecrets).where(eq(serverSecrets.key, key)).get();
  if (existing) return Buffer.from(existing.value, "base64url");
  const value = randomBytes(32).toString("base64url");
  db.insert(serverSecrets).values({ key, value, createdAt: Date.now() }).onConflictDoNothing().run();
  return Buffer.from(
    db.select().from(serverSecrets).where(eq(serverSecrets.key, key)).get()!.value,
    "base64url",
  );
}
