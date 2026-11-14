/**
 * Sign-in session length and "sign out everyone". Reads the database directly (not
 * settings.ts) because caller.ts, which settings.ts depends on, needs it on every request.
 */
import { eq, lte, sql } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import { SETTINGS_BY_KEY, resolveSettings } from "@/lib/settings/registry";
import { getDb, schema } from "./db";

const SESSION_DAYS_KEY = "security.sessionDays";
const EPOCH_KEY = "session-epoch";

/** Length of newly created sessions: the saved setting, pinned by POSTBOX_SESSION_DAYS when set. */
export function sessionTtl(env: NodeJS.ProcessEnv = process.env): number {
  const def = SETTINGS_BY_KEY.get(SESSION_DAYS_KEY)!;
  const row = getDb()
    .select()
    .from(schema.appSettings)
    .where(eq(schema.appSettings.key, SESSION_DAYS_KEY))
    .get();
  const { values } = resolveSettings(row ? { [SESSION_DAYS_KEY]: row.value } : {}, env, [def]);
  return Number(values[SESSION_DAYS_KEY]) * 86_400_000;
}

/** Mixed into the single-user (password) session key; changing it invalidates those cookies. */
export function sessionEpoch(): string {
  const db = getDb();
  const existing = db
    .select()
    .from(schema.serverSecrets)
    .where(eq(schema.serverSecrets.key, EPOCH_KEY))
    .get();
  if (existing) return existing.value;
  db.insert(schema.serverSecrets)
    .values({ key: EPOCH_KEY, value: randomBytes(16).toString("base64url"), createdAt: Date.now() })
    .onConflictDoNothing()
    .run();
  return db.select().from(schema.serverSecrets).where(eq(schema.serverSecrets.key, EPOCH_KEY)).get()!.value;
}

/**
 * Invalidate every browser session: account sessions (each user's session version) and the
 * single-user password session (the epoch). API tokens and POSTBOX_TOKEN are not affected.
 */
export function signOutEveryone(): { users: number } {
  const db = getDb();
  return db.transaction((tx) => {
    const users = tx
      .update(schema.users)
      .set({ sessionVersion: sql`${schema.users.sessionVersion} + 1` })
      .run().changes;
    tx.delete(schema.serverSecrets).where(eq(schema.serverSecrets.key, EPOCH_KEY)).run();
    return { users };
  });
}

/** Revocation key of a session cookie: a hash, so the table never holds a usable cookie. */
const revokedId = (cookie: string) =>
  createHash("sha256").update(`postbox-revoked-session\0${cookie}`).digest("base64url");

/** Whether this exact session cookie was ended by sign-out. */
export function isSessionRevoked(cookie: string): boolean {
  return !!getDb()
    .select({ id: schema.revokedSessions.id })
    .from(schema.revokedSessions)
    .where(eq(schema.revokedSessions.id, revokedId(cookie)))
    .get();
}

/**
 * End one browser session on the server: the cookie stops working everywhere, even where it
 * was copied. Kept until the cookie would have expired anyway; expired rows are pruned here.
 */
export function revokeSession(cookie: string, expiresAt: number, now = Date.now()) {
  const db = getDb();
  db.transaction((tx) => {
    tx.delete(schema.revokedSessions).where(lte(schema.revokedSessions.expiresAt, now)).run();
    if (expiresAt > now)
      tx.insert(schema.revokedSessions)
        .values({ id: revokedId(cookie), expiresAt })
        .onConflictDoNothing()
        .run();
  });
}
