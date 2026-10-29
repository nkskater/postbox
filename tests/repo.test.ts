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
      { ...params[0], value: "{{asn_id}}" }, params[1],
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
