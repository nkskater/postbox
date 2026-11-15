/** LAB-272: snapshot the database before applying migrations, and a full snapshot download. */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-snapshot-"));
process.env.DATABASE_PATH = path.join(dir, "server.db");

const { openDatabase } = await import("@/server/db");
const { listSnapshots, migrationState, pruneSnapshots, snapshotBeforeMigrations } =
  await import("@/server/db/snapshot");

const ENV_KEYS = [
  "MIGRATIONS_PATH",
  "POSTBOX_SKIP_MIGRATION_SNAPSHOT",
  "POSTBOX_MIGRATE_WITHOUT_SNAPSHOT",
  "POSTBOX_SNAPSHOT_DIR",
  "POSTBOX_SNAPSHOT_KEEP",
];
afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const journal = JSON.parse(fs.readFileSync("drizzle/meta/_journal.json", "utf8")) as {
  entries: { idx: number; tag: string; when: number }[];
};
const latestTag = journal.entries.at(-1)!.tag;

/** Migrations folder holding only the first `count` migrations, like an older release. */
function olderMigrations(count: number): string {
  const folder = fs.mkdtempSync(path.join(dir, "old-migrations-"));
  fs.mkdirSync(path.join(folder, "meta"));
  const entries = journal.entries.slice(0, count);
  for (const e of entries) fs.copyFileSync(`drizzle/${e.tag}.sql`, path.join(folder, `${e.tag}.sql`));
  fs.writeFileSync(path.join(folder, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
  return folder;
}

/** A populated database at an older migration: a user and a workspace. */
function legacyDatabase(name: string, count = journal.entries.length - 3): string {
  const file = path.join(dir, name);
  process.env.MIGRATIONS_PATH = olderMigrations(count);
  const legacy = openDatabase(file);
  delete process.env.MIGRATIONS_PATH;
  legacy.sqlite
    .prepare(
      "INSERT INTO users (id,username,password_hash,is_admin,created_at,updated_at) VALUES ('u1','old','x',1,1,1)",
    )
    .run();
  legacy.sqlite
    .prepare("INSERT INTO workspaces (id,name,created_at,updated_at) VALUES ('w1','Kept',1,1)")
    .run();
  legacy.sqlite.close();
  return file;
}

const tables = (file: string) => {
  const db = new Database(file, { readonly: true });
  try {
    return (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    ).map((t) => t.name);
  } finally {
    db.close();
  }
};

describe("snapshot before migrations", () => {
  it("saves a valid copy at the pre-migration schema when migrations are pending", () => {
    const file = legacyDatabase("upgrade.db");
    const before = tables(file);
    expect(before).not.toContain("revoked_sessions");

    const upgraded = openDatabase(file);
    upgraded.sqlite.close();

    const [snapshot] = listSnapshots(dir, file);
    expect(snapshot).toBeDefined();
    expect(path.basename(snapshot)).toMatch(
      new RegExp(`^upgrade\\.db\\.pre-migration-\\d{8}T\\d{6}Z-${journal.entries.at(-4)!.tag}\\.db$`),
    );
    // The snapshot is the old schema, with the old data, and opens as SQLite.
    expect(tables(snapshot).sort()).toEqual(before.sort());
    const copy = new Database(snapshot, { readonly: true });
    expect(copy.prepare("SELECT username FROM users").all()).toEqual([{ username: "old" }]);
    expect(copy.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    copy.close();
    // The live database was migrated.
    expect(tables(file)).toContain("revoked_sessions");
  });

  it("writes nothing for an up-to-date database or a new, empty one", () => {
    const file = path.join(dir, "upgrade.db");
    const count = listSnapshots(dir, file).length;
    openDatabase(file).sqlite.close();
    expect(listSnapshots(dir, file)).toHaveLength(count);

    const fresh = path.join(dir, "fresh.db");
    openDatabase(fresh).sqlite.close();
    expect(listSnapshots(dir, fresh)).toEqual([]);
  });

  it("keeps only the newest snapshots", () => {
    const file = legacyDatabase("keep.db");
    const sqlite = new Database(file);
    const folder = olderMigrations(journal.entries.length);
    process.env.POSTBOX_SNAPSHOT_KEEP = "2";
    for (const day of [1, 2, 3, 4])
      snapshotBeforeMigrations(sqlite, file, folder, process.env, new Date(`2026-01-0${day}T00:00:00Z`));
    sqlite.close();
    const kept = listSnapshots(dir, file).map((p) => path.basename(p));
    expect(kept).toHaveLength(2);
    expect(kept[0]).toContain("20260103T000000Z");
    expect(kept[1]).toContain("20260104T000000Z");
    pruneSnapshots(dir, file, 1);
    expect(listSnapshots(dir, file)).toHaveLength(1);
  });

  it("can be turned off, or written to another folder", () => {
    const off = legacyDatabase("off.db");
    process.env.POSTBOX_SKIP_MIGRATION_SNAPSHOT = "1";
    openDatabase(off).sqlite.close();
    expect(listSnapshots(dir, off)).toEqual([]);
    delete process.env.POSTBOX_SKIP_MIGRATION_SNAPSHOT;

    const elsewhere = legacyDatabase("elsewhere.db");
    const target = path.join(dir, "snapshots");
    process.env.POSTBOX_SNAPSHOT_DIR = target;
    openDatabase(elsewhere).sqlite.close();
    expect(listSnapshots(target, elsewhere)).toHaveLength(1);
    expect(listSnapshots(dir, elsewhere)).toEqual([]);
  });

  it("refuses to migrate when the snapshot cannot be written, unless allowed", () => {
    const file = legacyDatabase("blocked.db");
    const blocked = path.join(dir, "not-a-folder");
    fs.writeFileSync(blocked, "a file where the snapshot folder should be");
    process.env.POSTBOX_SNAPSHOT_DIR = blocked;
    expect(() => openDatabase(file)).toThrow(/POSTBOX_MIGRATE_WITHOUT_SNAPSHOT=1/);
    // Nothing was migrated.
    expect(tables(file)).not.toContain("revoked_sessions");

    process.env.POSTBOX_MIGRATE_WITHOUT_SNAPSHOT = "1";
    openDatabase(file).sqlite.close();
    expect(tables(file)).toContain("revoked_sessions");
  });

  it("reads the pending migrations from the journal and __drizzle_migrations", () => {
    const file = legacyDatabase("state.db", 10);
    const sqlite = new Database(file);
    const state = migrationState(sqlite, "drizzle");
    expect(state.hasData).toBe(true);
    expect(state.lastApplied?.tag).toBe(journal.entries[9].tag);
    expect(state.pending.map((e) => e.tag)).toEqual(journal.entries.slice(10).map((e) => e.tag));
    sqlite.close();
    openDatabase(file).sqlite.close();
    const done = new Database(file);
    expect(migrationState(done, "drizzle")).toMatchObject({ pending: [], lastApplied: { tag: latestTag } });
    done.close();
  });
});
