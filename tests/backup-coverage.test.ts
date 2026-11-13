import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-backup-coverage-"));
process.env.DATABASE_PATH = path.join(dir, "unused.db");

type Db = typeof import("@/server/db");
type Backup = typeof import("@/server/backup");
let dbm: Db;
let bk: Backup;

const roundTrip = (b: unknown) => JSON.parse(JSON.stringify(b));
const fresh = (name: string) => dbm.openDatabase(path.join(dir, `${name}.db`));

beforeAll(async () => {
  dbm = await import("@/server/db");
  bk = await import("@/server/backup");
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Tables whose rows go away when a workspace is deleted: direct cascades and their children. */
function removedWithWorkspaces(sqlite: import("better-sqlite3").Database): string[] {
  const tables = (
    sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[]
  ).map((t) => t.name);
  const cascadesFrom = new Map<string, string[]>();
  for (const table of tables) {
    const fks = sqlite.prepare(`PRAGMA foreign_key_list("${table}")`).all() as {
      table: string;
      on_delete: string;
    }[];
    for (const fk of fks)
      if (fk.on_delete === "CASCADE")
        cascadesFrom.set(fk.table, [...(cascadesFrom.get(fk.table) ?? []), table]);
  }
  const removed = new Set<string>();
  const queue = ["workspaces"];
  while (queue.length) {
    for (const child of cascadesFrom.get(queue.shift()!) ?? [])
      if (!removed.has(child)) {
        removed.add(child);
        queue.push(child);
      }
  }
  return [...removed].sort();
}

describe("backup coverage", () => {
  it("backs up or explicitly excludes every table a restore deletes", () => {
    const target = fresh("guard");
    try {
      const removed = removedWithWorkspaces(target.sqlite);
      // Sanity: the walk finds the tables the review listed.
      expect(removed).toEqual(expect.arrayContaining(["webhooks", "comments", "merge_request_reviews"]));
      const backedUp = new Set(bk.BACKED_UP_TABLES);
      const forgotten = removed.filter((t) => !backedUp.has(t) && !(t in bk.EXCLUDED_TABLES));
      expect(forgotten, "add these tables to the backup or to EXCLUDED_TABLES").toEqual([]);
      const both = bk.BACKED_UP_TABLES.filter((t) => t in bk.EXCLUDED_TABLES);
      expect(both).toEqual([]);
      const unknown = Object.keys(bk.EXCLUDED_TABLES).filter((t) => !removed.includes(t));
      expect(unknown, "EXCLUDED_TABLES lists tables a restore does not delete").toEqual([]);
    } finally {
      target.sqlite.close();
    }
  });

  it("documents every excluded table", () => {
    const doc = fs.readFileSync(path.join(__dirname, "..", "docs", "backup-and-data.md"), "utf8");
    for (const reason of new Set(Object.values(bk.EXCLUDED_TABLES))) expect(doc).toContain(reason);
  });
});

describe("workspace configuration round trip", () => {
  const now = 1_700_000_000_000;
  const vaultRef = "{{vault:hookToken}}";

  function seed(db: import("@/server/db").DB) {
    const s = dbm.schema;
    db.insert(s.users)
      .values({
        id: "u1",
        username: "owner",
        passwordHash: "x",
        role: "admin",
        createdAt: now,
        updatedAt: now,
      } as never)
      .run();
    db.insert(s.workspaces).values({ id: "ws", name: "Source", createdAt: now, updatedAt: now }).run();
    db.insert(s.folders)
      .values({
        id: "col",
        workspaceId: "ws",
        parentId: null,
        name: "API",
        auth: { type: "none" },
        headers: [],
        createdAt: now,
        updatedAt: now,
      } as never)
      .run();
    db.insert(s.webhooks)
      .values({
        id: "wh",
        workspaceId: "ws",
        name: "Deploys",
        url: "https://hooks.example.test/in",
        secret: "whsec_original",
        events: JSON.stringify(["run.finished"]),
        headers: JSON.stringify([
          { name: "X-Api-Key", value: "plain-header-secret" },
          { name: "X-Vault", value: vaultRef },
        ]),
        createdBy: "u1",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(s.hookListeners)
      .values({
        id: "hl",
        workspaceId: "ws",
        name: "Stripe",
        status: "active",
        tokenHash: "listener-hash",
        tokenHint: "abcd",
        verification: JSON.stringify({ type: "none" }),
        secret: "listener-shared-secret",
        createdBy: "gone-user",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(s.mcpCalls)
      .values({
        id: "mc",
        workspaceId: "ws",
        name: "List tools",
        config: {
          name: "List tools",
          connection: {
            url: "https://mcp.example.test",
            headers: [{ key: "Authorization", value: "Bearer mcp-token" }],
            timeoutMs: 15000,
          },
          action: { type: "tools/list" },
        },
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(s.runners)
      .values({
        id: "rn",
        workspaceId: "ws",
        name: "Office",
        labels: ["lan"],
        tokenHash: "runner-hash",
        allowHosts: [],
        denyHosts: [],
        lastSeenAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(s.comments)
      .values({
        id: "cm",
        workspaceId: "ws",
        targetKind: "folder",
        targetId: "col",
        body: "Looks good",
        authorId: "u1",
        authorName: "owner",
        mentions: [],
        createdAt: now,
      } as never)
      .run();
    const snapshot = { root: { id: "col", name: "API" } } as never;
    db.insert(s.dependencyReleases)
      .values({
        id: "rel",
        workspaceId: "ws",
        folderId: "col",
        name: "API",
        version: "1.0.0",
        seq: 1,
        visibility: "workspace",
        checksum: "c1",
        snapshot,
        createdAt: now,
      } as never)
      .run();
    db.insert(s.dependencyInstalls)
      .values({
        id: "ins",
        workspaceId: "ws",
        folderId: "col",
        releaseId: "rel",
        sourceWorkspaceId: "ws",
        sourceFolderId: "col",
        sourceName: "API",
        version: "1.0.0",
        checksum: "c1",
        baseSnapshot: snapshot,
        nodeMap: {},
        installedAt: now,
        updatedAt: now,
      } as never)
      .run();
    db.insert(s.collectionForks)
      .values({
        id: "fk",
        workspaceId: "ws",
        folderId: "col",
        parentWorkspaceId: "ws",
        parentFolderId: "col",
        parentName: "API",
        baseSnapshot: snapshot,
        nodeMap: {},
        createdAt: now,
        updatedAt: now,
      } as never)
      .run();
    db.insert(s.mergeRequests)
      .values({
        id: "mr",
        workspaceId: "ws",
        forkId: "fk",
        forkWorkspaceId: "ws",
        forkFolderId: "col",
        parentFolderId: "col",
        title: "Add endpoint",
        status: "open",
        createdByName: "owner",
        createdAt: now,
        updatedAt: now,
      } as never)
      .run();
    db.insert(s.mergeRequestReviews)
      .values({
        id: "rv",
        mergeRequestId: "mr",
        reviewerName: "owner",
        decision: "approve",
        headChecksum: "c1",
        createdAt: now,
      } as never)
      .run();
    db.insert(s.brokerApis)
      .values({
        id: "api",
        workspaceId: "ws",
        name: "Payments",
        baseUrl: "https://pay.example.test",
        secretName: "payKey",
        injection: { type: "bearer" },
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(s.gatewayRoutes)
      .values({
        id: "gr",
        workspaceId: "ws",
        apiId: "api",
        name: "pay",
        kind: "api",
        enabled: true,
        policy: {} as never,
        minuteWindow: now,
        minuteUsed: 7,
        dayWindow: now,
        dayUsed: 70,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }

  const NEW_TABLES = [
    "webhooks",
    "hookListeners",
    "mcpCalls",
    "runners",
    "comments",
    "dependencyReleases",
    "dependencyInstalls",
    "collectionForks",
    "mergeRequests",
    "mergeRequestReviews",
    "gatewayRoutes",
  ] as const;

  it("keeps webhooks, listeners, comments, forks, releases, runners, routes and MCP calls", () => {
    const source = fresh("round-trip-source");
    try {
      seed(source.db);
      const backup = roundTrip(bk.createBackup(source.db, { includeSecrets: true }));
      for (const name of NEW_TABLES) expect(backup.tables[name], name).toHaveLength(1);

      // Restoring into the same database used to delete everything that was not in the file.
      const summary = bk.restoreBackup(source.db, source.sqlite, backup);
      for (const name of NEW_TABLES) expect(summary[name], name).toBe(1);
      const after = bk.createBackup(source.db, { includeSecrets: true });
      for (const name of NEW_TABLES) expect(after.tables[name], name).toHaveLength(1);

      const s = dbm.schema;
      const webhook = source.db.select().from(s.webhooks).get()!;
      expect(webhook.secret).toBe("whsec_original");
      expect(webhook.enabled).toBe(true);
      expect(source.db.select().from(s.hookListeners).get()).toMatchObject({
        tokenHash: "listener-hash",
        status: "active",
        createdBy: null, // the creator's account does not exist here
      });
      expect(source.db.select().from(s.runners).get()).toMatchObject({
        tokenHash: "runner-hash",
        lastSeenAt: null,
        revokedAt: null,
      });
      expect(source.db.select().from(s.comments).get()).toMatchObject({ authorId: "u1", body: "Looks good" });
      expect(source.db.select().from(s.mergeRequestReviews).get()).toMatchObject({ decision: "approve" });
      expect(source.db.select().from(s.gatewayRoutes).get()).toMatchObject({
        enabled: true,
        minuteUsed: 0,
        dayUsed: 0,
      });
    } finally {
      source.sqlite.close();
    }
  });

  it("restores into a database without the authors' accounts", () => {
    const source = fresh("accounts-source");
    const target = fresh("accounts-target");
    try {
      seed(source.db);
      bk.restoreBackup(
        target.db,
        target.sqlite,
        roundTrip(bk.createBackup(source.db, { includeSecrets: true })),
      );
      const s = dbm.schema;
      expect(target.db.select().from(s.comments).get()).toMatchObject({
        authorId: null,
        authorName: "owner",
      });
      expect(target.db.select().from(s.webhooks).get()?.createdBy).toBeNull();
    } finally {
      source.sqlite.close();
      target.sqlite.close();
    }
  });

  it("leaves their credentials out of a backup without secrets", () => {
    const source = fresh("scrub-source");
    try {
      seed(source.db);
      const backup = roundTrip(bk.createBackup(source.db, { includeSecrets: false }));
      const text = JSON.stringify(backup);
      for (const secret of [
        "whsec_original",
        "plain-header-secret",
        "listener-shared-secret",
        "listener-hash",
        "runner-hash",
        "mcp-token",
      ])
        expect(text, secret).not.toContain(secret);
      expect(text).toContain(vaultRef);

      bk.restoreBackup(source.db, source.sqlite, backup);
      const s = dbm.schema;
      const webhook = source.db.select().from(s.webhooks).get()!;
      expect(webhook.enabled).toBe(false);
      expect(webhook.secret).toMatch(/^whsec_/);
      expect(source.db.select().from(s.hookListeners).get()).toMatchObject({ status: "paused", secret: "" });
      expect(source.db.select().from(s.runners).get()?.revokedAt).not.toBeNull();
    } finally {
      source.sqlite.close();
    }
  });

  it("still restores a backup made before these tables were included", () => {
    const source = fresh("old-format-source");
    const target = fresh("old-format-target");
    try {
      seed(source.db);
      const backup = roundTrip(bk.createBackup(source.db, { includeSecrets: true }));
      for (const name of NEW_TABLES) delete backup.tables[name];
      const summary = bk.restoreBackup(target.db, target.sqlite, backup);
      expect(summary.workspaces).toBe(1);
      expect(summary.webhooks).toBe(0);
    } finally {
      source.sqlite.close();
      target.sqlite.close();
    }
  });
});
