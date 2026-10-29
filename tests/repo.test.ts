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
