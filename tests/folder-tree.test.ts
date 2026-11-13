import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { DEFAULT_SETTINGS } from "@/core/types";
import os from "node:os";
import path from "node:path";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-folder-tree-"));
process.env.DATABASE_PATH = path.join(directory, "test.db");
let repo: typeof import("@/server/repo");
let sqlite: ReturnType<typeof import("@/server/db").getSqlite>;
beforeAll(async () => {
  repo = await import("@/server/repo");
  sqlite = (await import("@/server/db")).getSqlite();
});
afterAll(() => {
  sqlite.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("folder subtree loading", () => {
  it("fetches only subtree rows even when unrelated collections have large payloads", () => {
    const ws = repo.createWorkspace("Large workspace");
    const root = repo.createFolder(ws.id, null, { name: "Small" });
    const child = repo.createFolder(ws.id, root.id);
    repo.createRequest(ws.id, child.id, { name: "Only request" });
    const other = repo.createFolder(ws.id, null);
    const template = repo.createRequest(ws.id, other.id);
    const insert =
      sqlite.prepare(`INSERT INTO requests (id, workspace_id, folder_id, name, sort, method, url, params, headers,
        body, auth, pre_request_script, test_script, settings, contract, examples,
        description, created_at, updated_at)
      SELECT ? AS id, workspace_id, folder_id, name, sort, method, url, params, headers,
        ? AS body, auth, pre_request_script, test_script, settings, contract, examples,
        description, created_at, updated_at FROM requests WHERE id = ?`);
    // Bad JSON makes accidental hydration fail as well as increasing unrelated row size.
    const payload = "not-json-" + "x".repeat(200_000);
    sqlite.transaction(() => {
      for (let i = 0; i < 100; i++) insert.run(`unrelated-${i}`, payload, template.id);
    })();
    const prepare = sqlite.prepare.bind(sqlite);
    const reads: { query: string; count: number; plan: unknown[] }[] = [];
    const spy = vi.spyOn(sqlite, "prepare").mockImplementation((query) => {
      const statement = prepare(query);
      const all = statement.all.bind(statement);
      vi.spyOn(statement, "all").mockImplementation((...params: unknown[]) => {
        const rows = all(...params);
        reads.push({
          query,
          count: rows.length,
          plan: prepare(`EXPLAIN QUERY PLAN ${query}`).all(...params),
        });
        return rows;
      });
      return statement;
    });
    try {
      const tree = repo.getFolderTree(root.id)!;
      expect(tree.children[0]).toMatchObject({ children: [{ name: "Only request" }] });
    } finally {
      spy.mockRestore();
    }
    const folders = reads.find((read) => /from "folders"/.test(read.query));
    const requests = reads.find((read) => /from "requests"/.test(read.query));
    expect(folders?.count).toBe(2);
    expect(requests?.count).toBe(1);
    expect(JSON.stringify(folders?.plan)).toMatch(/folders_parent_idx|folders_workspace_parent_sort_idx/);
    expect(JSON.stringify(requests?.plan)).toMatch(/requests_folder_idx|requests_folder_sort_idx/);
  });

  it("preserves full definitions, empty folders, nesting and mixed sibling ordering", () => {
    const ws = repo.createWorkspace("Ordering");
    const root = repo.createFolder(ws.id, null, {
      name: "Root",
      description: "Collection description",
      preRequestScript: "console.log('root')",
      auth: { type: "bearer", bearer: { token: "token" } },
      headers: [{ key: "X-Root", value: "value", enabled: true }],
    });
    const first = repo.createRequest(ws.id, root.id, { name: "First" });
    const empty = repo.createFolder(ws.id, root.id, { name: "Empty" });
    const nested = repo.createFolder(ws.id, root.id, { name: "Nested" });
    const request = repo.createRequest(ws.id, nested.id, {
      name: "Payload",
      method: "POST",
      url: "https://example.test/",
      description: "Request description",
      body: { mode: "raw", raw: "body", language: "text" },
      testScript: "pm.test('ok', () => {})",
      settings: { ...DEFAULT_SETTINGS, timeoutMs: 42, verifySsl: false },
    });
    const tied = repo.createRequest(ws.id, root.id, { name: "Tied" });
    sqlite.prepare("UPDATE requests SET sort = 1 WHERE id = ?").run(tied.id);
    const tree = repo.getFolderTree(root.id)!;
    expect(tree).toMatchObject({
      id: root.id,
      kind: "folder",
      name: root.name,
      description: root.description,
      auth: root.auth,
      headers: root.headers,
      preRequestScript: root.preRequestScript,
    });
    expect(tree).not.toHaveProperty("parentId");
    expect(tree).not.toHaveProperty("sort");
    expect(tree.children.map((node) => node.id)).toEqual([first.id, empty.id, tied.id, nested.id]);
    expect(tree.children[1]).toMatchObject({ kind: "folder", children: [] });
    expect(tree.children[3]).toMatchObject({
      children: [
        {
          id: request.id,
          kind: "request",
          name: request.name,
          method: request.method,
          url: request.url,
          body: request.body,
          description: request.description,
          settings: request.settings,
          testScript: request.testScript,
          folderId: nested.id,
        },
      ],
    });
    expect(repo.getFolderChildIds(root.id)).toEqual(tree.children.map((node) => node.id));
    expect(repo.getFolderTree(empty.id)?.children).toEqual([]);
    expect(repo.getFolderTree("missing")).toBeNull();
    expect(repo.getFolderChildIds("missing")).toEqual([]);
  });

  it("does not traverse foreign workspace children or load requests from another workspace", () => {
    const ws = repo.createWorkspace("Local");
    const foreign = repo.createWorkspace("Foreign");
    const root = repo.createFolder(ws.id, null);
    const foreignChild = repo.createFolder(foreign.id, null);
    const foreignRequest = repo.createRequest(foreign.id, foreignChild.id);
    sqlite.prepare("UPDATE folders SET parent_id = ? WHERE id = ?").run(root.id, foreignChild.id);
    sqlite.prepare("UPDATE requests SET folder_id = ? WHERE id = ?").run(root.id, foreignRequest.id);
    expect(repo.getFolderTree(root.id)?.children).toEqual([]);
    expect(repo.getFolderChildIds(root.id)).toEqual([]);
  });

  it("terminates recursive SQL and retains the explicit cycle error", () => {
    const ws = repo.createWorkspace("Cycle");
    const root = repo.createFolder(ws.id, null);
    const child = repo.createFolder(ws.id, root.id);
    sqlite.prepare("UPDATE folders SET parent_id = ? WHERE id = ?").run(child.id, root.id);
    expect(() => repo.getFolderTree(root.id)).toThrow("Folder tree contains a cycle");
  });

  it("loads immediate child order without decoding folder or request payloads", () => {
    const ws = repo.createWorkspace("Metadata");
    const root = repo.createFolder(ws.id, null);
    const child = repo.createFolder(ws.id, root.id);
    const request = repo.createRequest(ws.id, root.id);
    sqlite.prepare("UPDATE folders SET auth = 'not-json' WHERE workspace_id = ?").run(ws.id);
    sqlite.prepare("UPDATE requests SET body = 'not-json' WHERE id = ?").run(request.id);
    expect(repo.getFolderChildIds(root.id)).toEqual([child.id, request.id]);
  });
});
