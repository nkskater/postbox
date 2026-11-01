/**
 * Sign-in session length and "sign out everyone". Reads the database directly (not
 * settings.ts) because caller.ts, which settings.ts depends on, needs it on every request.
 */
import { eq, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
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
