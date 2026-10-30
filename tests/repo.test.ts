import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { importPostmanCollection } from "@/core/convert/postman";

// Use a throwaway database for repository tests.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-test-"));
process.env.DATABASE_PATH = path.join(dir, "test.db");

type Repo = typeof import("@/server/repo");
let repo: Repo;
beforeAll(async () => {
  repo = await import("@/server/repo");
});

describe("repository", () => {
  it("derives query params on create when omitted or empty", () => {
    const ws = repo.createWorkspace("Query params");
    const folder = repo.createFolder(ws.id, null);
    for (const partial of [{}, { params: [] }]) {
      const request = repo.createRequest(ws.id, folder.id, {
        url: "{{host}}/api?asn={{asn_id}}&tag=a&tag=b&flag&encoded=a%20b#fragment",
        ...partial,
      });
      expect(request.params).toEqual([
        { key: "asn", value: "{{asn_id}}", enabled: true },
        { key: "tag", value: "a", enabled: true },
        { key: "tag", value: "b", enabled: true },
        { key: "flag", value: "", enabled: true },
        { key: "encoded", value: "a%20b", enabled: true },
      ]);
      expect(repo.getRequest(request.id)?.params).toEqual(request.params);
    }
    expect(repo.createRequest(ws.id, folder.id, { url: "http://host/api" }).params).toEqual([]);
  });

  it("refreshes params on URL-only updates and preserves explicit params and disabled rows", () => {
    const ws = repo.createWorkspace("Update params");
    const folder = repo.createFolder(ws.id, null);
    const params = [
      { key: "asn", value: "old", enabled: true, description: "ASN" },
      { key: "hidden", value: "saved", enabled: false },
    ];
    const request = repo.createRequest(ws.id, folder.id, { url: "http://host?asn=old", params });
    expect(request.params).toEqual(params);
    expect(repo.updateRequest(request.id, { name: "Renamed" })?.params).toEqual(params);
    expect(repo.updateRequest(request.id, { url: "http://host?asn={{asn_id}}" })?.params).toEqual([
      { ...params[0], value: "{{asn_id}}" },
      params[1],
    ]);
    expect(repo.updateRequest(request.id, { url: "http://host" })?.params).toEqual([params[1]]);
    expect(repo.updateRequest(request.id, { url: "http://host?x=1", params: [] })?.params).toEqual([
      { key: "x", value: "1", enabled: true },
    ]);
    expect(repo.updateRequest(request.id, { params: [] })?.params).toEqual([
      { key: "x", value: "1", enabled: true },
    ]);
    expect(repo.updateRequest(request.id, { url: "http://host?x=2", params })?.params).toEqual(params);
    expect(repo.updateRequest(request.id, { url: "http://host", params: [] })?.params).toEqual([]);
  });

  it("appends after the maximum mixed sibling sort without including other parents or workspaces", async () => {
    const { getSqlite } = await import("@/server/db");
    const sqlite = getSqlite();
    const ws = repo.createWorkspace("Sibling sorts");
    const otherWs = repo.createWorkspace("Other workspace");
    const root = repo.createFolder(ws.id, null);
    expect(root.sort).toBe(0);
    const otherRoot = repo.createFolder(otherWs.id, null);
    sqlite.prepare("UPDATE folders SET sort = 9000 WHERE id = ?").run(otherRoot.id);
    const otherParent = repo.createFolder(ws.id, null);
    expect(otherParent.sort).toBe(1);
    const unrelated = repo.createFolder(ws.id, otherParent.id);
    sqlite.prepare("UPDATE folders SET sort = 8000 WHERE id = ?").run(unrelated.id);
    const unrelatedRequest = repo.createRequest(ws.id, otherParent.id);
    sqlite.prepare("UPDATE requests SET sort = 10000 WHERE id = ?").run(unrelatedRequest.id);

    const child = repo.createFolder(ws.id, root.id);
    expect(child.sort).toBe(0);
    const request = repo.createRequest(ws.id, root.id);
    expect(request.sort).toBe(1);
    sqlite.prepare("UPDATE folders SET sort = 50 WHERE id = ?").run(child.id);
    expect(repo.createRequest(ws.id, root.id).sort).toBe(51);
    sqlite.prepare("UPDATE requests SET sort = 100 WHERE id = ?").run(request.id);
    expect(repo.createFolder(ws.id, root.id).sort).toBe(101);
    expect(repo.createRequest(ws.id, root.id).sort).toBe(102);
    expect(repo.createFolder(ws.id, null).sort).toBe(2);
  });

  it("starts at zero when existing sibling sorts are negative", async () => {
    const { getSqlite } = await import("@/server/db");
    const sqlite = getSqlite();
    const ws = repo.createWorkspace("Negative sorts");
    const root = repo.createFolder(ws.id, null);
    sqlite.prepare("UPDATE folders SET sort = -5 WHERE id = ?").run(root.id);
    expect(repo.createFolder(ws.id, null).sort).toBe(0);
    const child = repo.createFolder(ws.id, root.id);
    const request = repo.createRequest(ws.id, root.id);
    sqlite.prepare("UPDATE folders SET sort = -3 WHERE id = ?").run(child.id);
    sqlite.prepare("UPDATE requests SET sort = -2 WHERE id = ?").run(request.id);
    expect(repo.createRequest(ws.id, root.id).sort).toBe(0);
  });

  it("appends folders and requests with 160,000 mixed siblings", async () => {
    const { getSqlite } = await import("@/server/db");
    const sqlite = getSqlite();
    const ws = repo.createWorkspace("Large sibling set");
    const root = repo.createFolder(ws.id, null);
    const count = 80000;
    // Bulk seed directly so setup does not repeatedly calculate nextSort.
    sqlite.transaction(() => {
      sqlite
        .prepare(
          `
        WITH RECURSIVE seq(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM seq WHERE i + 1 < ?)
        INSERT INTO folders (id, workspace_id, parent_id, name, sort, auth, headers, created_at, updated_at)
        SELECT 'bulk-folder-' || i, ?, ?, 'Folder', i * 2, '{}', '[]', 0, 0 FROM seq
      `,
        )
        .run(count, ws.id, root.id);
      sqlite
        .prepare(
          `
        WITH RECURSIVE seq(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM seq WHERE i + 1 < ?)
        INSERT INTO requests (id, workspace_id, folder_id, name, sort, method, params, headers, body, auth, settings, examples, created_at, updated_at)
        SELECT 'bulk-request-' || i, ?, ?, 'Request', i * 2 + 1, 'GET', '[]', '[]', '{}', '{}', '{}', '[]', 0, 0 FROM seq
      `,
        )
        .run(count, ws.id, root.id);
    })();
    expect(repo.createFolder(ws.id, root.id).sort).toBe(count * 2);
    expect(repo.createRequest(ws.id, root.id).sort).toBe(count * 2 + 1);
    repo.deleteWorkspace(ws.id);
  });

  it("uses covering indexes to find maximum sibling sorts", async () => {
    const { getSqlite } = await import("@/server/db");
    const sqlite = getSqlite();
    const queries = [
      {
        sql: "SELECT max(sort) FROM folders WHERE workspace_id = ? AND parent_id = ?",
        params: ["workspace", "parent"],
        index: "folders_workspace_parent_sort_idx",
      },
      {
        sql: "SELECT max(sort) FROM folders WHERE workspace_id = ? AND parent_id IS NULL",
        params: ["workspace"],
        index: "folders_workspace_parent_sort_idx",
      },
      {
        sql: "SELECT max(sort) FROM requests WHERE folder_id = ?",
        params: ["parent"],
        index: "requests_folder_sort_idx",
      },
    ];
    for (const query of queries) {
      const plan = JSON.stringify(sqlite.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.params));
      expect(plan).toContain(`USING COVERING INDEX ${query.index}`);
      expect(plan).not.toContain("SCAN");
      expect(plan).not.toContain("USE TEMP B-TREE");
    }
  });

  it("loads only the requested subtree and preserves mixed sibling order", () => {
    const ws = repo.createWorkspace("Tree ordering");
    const root = repo.createFolder(ws.id, null, { name: "Root" });
    const other = repo.createFolder(ws.id, null, { name: "Other" });
    repo.createRequest(ws.id, other.id, { name: "Excluded" });
    const child = repo.createFolder(ws.id, root.id, { name: "Child" });
    repo.createRequest(ws.id, child.id, { name: "Nested" });
    const request = repo.createRequest(ws.id, root.id, { name: "First" });
    repo.reorder("request", request.id, root.id, 0);
    const tree = repo.getFolderTree(root.id)!;
    expect(tree.children.map((node) => node.name)).toEqual(["First", "Child"]);
    expect(tree.children[1]).toMatchObject({ children: [{ name: "Nested" }] });
  });

  it("uses migrated indexes for workspace request and environment ordering", async () => {
    const { getSqlite } = await import("@/server/db");
    const sqlite = getSqlite();
    for (const table of ["requests", "environments"]) {
      const plan = sqlite
        .prepare(`EXPLAIN QUERY PLAN SELECT * FROM ${table} WHERE workspace_id = ? ORDER BY sort, created_at`)
        .all("workspace");
      expect(JSON.stringify(plan)).toContain(`${table}_workspace_sort_idx`);
      expect(JSON.stringify(plan)).not.toContain("USE TEMP B-TREE");
    }
  });

  it("imports a tree, persists variable diffs and reorders items", () => {
    const ws = repo.createWorkspace("Test");
    const { root, variables } = importPostmanCollection({
      info: { name: "Col" },
      variable: [{ key: "a", value: "1" }],
      item: [
        {
          name: "F",
          item: [
            { name: "R1", request: { url: "http://x/1" } },
            { name: "R2", request: { url: "http://x/2" } },
          ],
        },
      ],
    });
    const result = repo.importTree(ws.id, root, variables);
    expect(result).toMatchObject({ name: "Col", folders: 1, requests: 2 });
    expect(repo.listVariables(ws.id, "collection", result.id)).toMatchObject([{ key: "a", value: "1" }]);

    const tree = repo.getFolderTree(result.id)!;
    const folder = tree.children[0];
    if (folder.kind !== "folder") throw new Error("expected folder");
    const [r1, r2] = folder.children;
    repo.reorder("request", r2.id, folder.id, 0);
    const after = repo.getFolderTree(folder.id)!;
    expect(after.children.map((c) => c.name)).toEqual(["R2", "R1"]);
    expect(() => repo.reorder("folder", result.id, folder.id, 0)).toThrow(/itself/);

    repo.persistScopeDiff(ws.id, "collection", result.id, { a: "1" }, { a: "2", b: "3" });
    expect(repo.listVariables(ws.id, "collection", result.id).map((v) => [v.key, v.value])).toEqual([
      ["a", "2"],
      ["b", "3"],
    ]);

    const copy = repo.duplicateFolder(result.id)!;
    expect(repo.getFolderTree(copy.id)!.children[0]).toMatchObject({ name: "F", kind: "folder" });
    expect(repo.listVariables(ws.id, "collection", copy.id)).toHaveLength(2);

    repo.deleteFolder(result.id);
    expect(repo.getRequest(r1.id)).toBeNull();
  });
});
