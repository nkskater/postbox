import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { expect, it } from "vitest";
it("upgrades a populated pre-SSO database without changing users or roles and preserves existing gateway tables", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-sso-migration-")),
    sqlite = new Database(path.join(dir, "upgrade.db"));
  try {
    sqlite.pragma("foreign_keys = ON");
    const old = path.join(dir, "old");
    fs.cpSync("drizzle", old, { recursive: true });
    const journalPath = path.join(old, "meta", "_journal.json"),
      journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
    const latest = journal.entries.pop();
    expect(latest.idx).toBe(46);
    fs.writeFileSync(journalPath, JSON.stringify(journal));
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: old });
    sqlite
      .prepare(
        "INSERT INTO users(id,username,display_name,password_hash,is_admin,disabled,is_service,session_version,created_at,updated_at) VALUES('user','existing','Existing','!',0,0,0,7,1,1)",
      )
      .run();
    sqlite
      .prepare("INSERT INTO workspaces(id,name,created_at,updated_at) VALUES('workspace','Existing',1,1)")
      .run();
    sqlite
      .prepare(
        "INSERT INTO workspace_members(workspace_id,user_id,role,created_at) VALUES('workspace','user','editor',1)",
      )
      .run();
    const before = sqlite.prepare("SELECT * FROM users").all();
    migrate(db, { migrationsFolder: "drizzle" });
    expect(sqlite.prepare("SELECT * FROM users").all()).toEqual(before);
    expect(sqlite.prepare("SELECT role FROM workspace_members").get()).toEqual({ role: "editor" });
    expect(sqlite.prepare("SELECT count(*) AS n FROM gateway_routes").get()).toEqual({ n: 0 });
    expect(sqlite.prepare("SELECT count(*) AS n FROM sso_providers").get()).toEqual({ n: 0 });
    expect(sqlite.pragma("foreign_key_check")).toEqual([]);
    expect(sqlite.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
  } finally {
    sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
