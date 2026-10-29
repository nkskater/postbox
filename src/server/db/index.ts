/**
 * Database connection singleton.
 *
 * Opens the SQLite file at DATABASE_PATH (default /data/postbox.db in production,
 * ./data/postbox.db in development), enables WAL, and applies pending migrations.
 */
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import path from "node:path";
import * as schema from "./schema";

export type DB = BetterSQLite3Database<typeof schema>;

interface DbHolder {
  db: DB;
  sqlite: Database.Database;
}

const globalForDb = globalThis as unknown as { __postboxDb?: DbHolder };

export function resolveDatabasePath(): string {
  if (process.env.DATABASE_PATH) return process.env.DATABASE_PATH;
  return process.env.NODE_ENV === "production" ? "/data/postbox.db" : path.join(process.cwd(), "data", "postbox.db");
}

function resolveMigrationsFolder(): string {
  const candidates = [
    process.env.MIGRATIONS_PATH,
    path.join(process.cwd(), "drizzle"),
    path.join(import.meta.dirname ?? "", "../../../drizzle"),
  ].filter(Boolean) as string[];
  const found = candidates.find((p) => fs.existsSync(path.join(p, "meta", "_journal.json")));
  if (!found) throw new Error(`Could not find migrations folder (looked in ${candidates.join(", ")})`);
  return found;
}

/** Open (or create) a database at the given path and run migrations. */
export function openDatabase(file: string): DbHolder {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: resolveMigrationsFolder() });
  return { db, sqlite };
}

/** Lazily-initialised shared connection for the server process. */
export function getDb(): DB {
  if (!globalForDb.__postboxDb) {
    globalForDb.__postboxDb = openDatabase(resolveDatabasePath());
  }
  return globalForDb.__postboxDb.db;
}

export function getSqlite(): Database.Database {
  getDb();
  return globalForDb.__postboxDb!.sqlite;
}

export { schema };
