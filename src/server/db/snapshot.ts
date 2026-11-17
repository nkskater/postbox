/**
 * Database snapshots: a consistent copy of the SQLite file taken with `VACUUM INTO`.
 *
 * - Before migrations: when an upgrade brings migrations the database has not applied yet, a
 *   snapshot of the pre-upgrade file is written next to it (or to POSTBOX_SNAPSHOT_DIR), so a
 *   failed or wrong migration can be rolled back. The newest POSTBOX_SNAPSHOT_KEEP (default 3)
 *   are kept. POSTBOX_SKIP_MIGRATION_SNAPSHOT=1 turns this off; if a snapshot cannot be written
 *   the server refuses to start unless POSTBOX_MIGRATE_WITHOUT_SNAPSHOT=1.
 * - On demand: GET /api/backup/snapshot and `postbox backup snapshot` stream a complete copy.
 */
import type Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

export const DEFAULT_SNAPSHOT_KEEP = 3;

function journal(migrationsFolder: string): JournalEntry[] {
  const file = path.join(migrationsFolder, "meta", "_journal.json");
  return (JSON.parse(fs.readFileSync(file, "utf8")) as { entries: JournalEntry[] }).entries;
}

/**
 * Migrations from the journal this database has not applied yet, and the last one it has.
 * Mirrors drizzle's migrator, which applies every journal entry newer than the latest
 * `created_at` in `__drizzle_migrations`.
 */
export function migrationState(
  sqlite: Database.Database,
  migrationsFolder: string,
): { pending: JournalEntry[]; lastApplied: JournalEntry | null; hasData: boolean } {
  const entries = journal(migrationsFolder);
  const tables = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  const hasData = tables.some((t) => t.name !== "__drizzle_migrations");
  let latest = -Infinity;
  if (tables.some((t) => t.name === "__drizzle_migrations")) {
    const row = sqlite.prepare("SELECT MAX(created_at) AS latest FROM __drizzle_migrations").get() as {
      latest: number | null;
    };
    latest = Number(row.latest ?? -Infinity);
  }
  const pending = entries.filter((e) => e.when > latest);
  const applied = entries.filter((e) => e.when <= latest);
  return { pending, lastApplied: applied.at(-1) ?? null, hasData };
}

/** Write a consistent copy of the open database to `target` (atomically: temp file, then rename). */
export function writeSnapshot(sqlite: Database.Database, target: string) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.partial`;
  fs.rmSync(temp, { force: true });
  try {
    sqlite.prepare("VACUUM INTO ?").run(temp);
    fs.renameSync(temp, target);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

const stamp = (now: Date) =>
  now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");

/** Pre-migration snapshots of `dbFile` in `dir`, oldest first. */
export function listSnapshots(dir: string, dbFile: string): string[] {
  const prefix = `${path.basename(dbFile)}.pre-migration-`;
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".db"))
    .sort()
    .map((name) => path.join(dir, name));
}

/** Delete all but the newest `keep` pre-migration snapshots. */
export function pruneSnapshots(dir: string, dbFile: string, keep: number) {
  const all = listSnapshots(dir, dbFile);
  for (const old of all.slice(0, Math.max(0, all.length - keep))) fs.rmSync(old, { force: true });
}

/**
 * Called by openDatabase before migrate(). Returns the snapshot written, if any. Throws when a
 * snapshot was needed but could not be written, unless the operator allowed migrating without one.
 */
export function snapshotBeforeMigrations(
  sqlite: Database.Database,
  dbFile: string,
  migrationsFolder: string,
  env: NodeJS.ProcessEnv = process.env,
  now = new Date(),
): string | null {
  if (dbFile === ":memory:" || env.POSTBOX_SKIP_MIGRATION_SNAPSHOT === "1") return null;
  const { pending, lastApplied, hasData } = migrationState(sqlite, migrationsFolder);
  if (!pending.length || !hasData) return null;
  const dir = env.POSTBOX_SNAPSHOT_DIR || path.dirname(path.resolve(dbFile));
  const keep = Math.max(1, Number(env.POSTBOX_SNAPSHOT_KEEP) || DEFAULT_SNAPSHOT_KEEP);
  const target = path.join(
    dir,
    `${path.basename(dbFile)}.pre-migration-${stamp(now)}-${lastApplied?.tag ?? "unversioned"}.db`,
  );
  try {
    writeSnapshot(sqlite, target);
  } catch (error) {
    const reason = (error as Error).message;
    if (env.POSTBOX_MIGRATE_WITHOUT_SNAPSHOT === "1") {
      console.warn(
        `[postbox] Could not write a snapshot before ${pending.length} pending migration(s) (${reason}); continuing because POSTBOX_MIGRATE_WITHOUT_SNAPSHOT=1.`,
      );
      return null;
    }
    throw new Error(
      `Postbox needs to apply ${pending.length} database migration(s), but could not first save a snapshot of ` +
        `${dbFile} to ${dir}: ${reason}. Free some disk space or make the folder writable (or set ` +
        `POSTBOX_SNAPSHOT_DIR to another folder). To upgrade without a snapshot, set POSTBOX_MIGRATE_WITHOUT_SNAPSHOT=1.`,
      { cause: error },
    );
  }
  pruneSnapshots(dir, dbFile, keep);
  console.log(`[postbox] Saved a snapshot of the database before ${pending.length} migration(s): ${target}`);
  return target;
}
