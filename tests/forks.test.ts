import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Caller } from "@/server/caller";
import type { UserRow } from "@/server/db/schema";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-forks-"));
process.env.DATABASE_PATH = path.join(dir, "test.db");
const { getSqlite } = await import("@/server/db");
const users = await import("@/server/users");
const repo = await import("@/server/repo");
const { withCaller } = await import("@/server/access-context");
const { setMember } = await import("@/server/authorize");
const forksApi = await import("@/server/forks");
const comments = await import("@/server/comments");
const caller = (user: UserRow): Caller => ({ kind: "user", user, via: "session" });
const as = <T>(u: UserRow, fn: () => T) => withCaller(caller(u), fn);

let owner: UserRow, editor: UserRow, viewer: UserRow, forker: UserRow, outsider: UserRow;
let wsP: string, wsF: string;

beforeAll(async () => {
  repo.createWorkspace("Before accounts");
  await users.createUser({ username: "admin", password: "password123", isAdmin: true });
  for (const name of ["owner", "editor", "viewer", "forker", "outsider"])
    await users.createUser({ username: name, password: "password123" });
  const get = (name: string) => users.getUserByUsername(name)!;
  owner = get("owner");
  editor = get("editor");
  viewer = get("viewer");
  forker = get("forker");
  outsider = get("outsider");
  wsP = as(owner, () => repo.createWorkspace("Parent team")).id;
  as(owner, () => {
    setMember(wsP, editor.username, "editor");
    setMember(wsP, viewer.username, "viewer");
    setMember(wsP, forker.username, "viewer");
  });
  wsF = as(forker, () => repo.createWorkspace("Forker space")).id;
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

/** A fresh parent collection with two requests and a folder, plus a fork of it. */
function setup(name: string) {
  const parent = as(owner, () => repo.createFolder(wsP, null, { name })).id;
  const list = as(owner, () =>
    repo.createRequest(wsP, parent, {
      name: "List",
      url: "{{base}}/items",
      headers: [{ key: "Authorization", value: "Bearer parent-secret", enabled: true }],
    }),
  ).id;
  const sub = as(owner, () => repo.createFolder(wsP, parent, { name: "Admin" })).id;
  const drop = as(owner, () => repo.createRequest(wsP, sub, { name: "Drop", url: "{{base}}/drop" })).id;
  as(owner, () =>
    repo.replaceVariables(wsP, "collection", parent, [
      { key: "base", value: "https://api.test", type: "default", enabled: true },
    ]),
  );
  const fork = as(forker, () => forksApi.forkCollection(parent, { workspaceId: wsF }));
  return { parent, list, sub, drop, fork };
}
const requestNamed = (folderId: string, name: string): string | null => {
  const walk = (n: ReturnType<typeof repo.getFolderTree> | undefined): string | null => {
    if (!n) return null;
    for (const c of n.children) {
      if (c.kind === "request" && c.name === name) return c.id;
      if (c.kind === "folder") {
        const hit = walk(c);
        if (hit) return hit;
      }
    }
    return null;
  };
  return walk(repo.getFolderTree(folderId));
};
const edit = (u: UserRow, folderId: string, name: string, patch: Parameters<typeof repo.updateRequest>[1]) =>
  as(u, () => repo.updateRequest(requestNamed(folderId, name)!, patch));
const openMr = (forkId: string, title = "Improve it") =>
  as(forker, () => forksApi.openMergeRequest(forkId, { title, description: "" }));
/** The details of an open request (they are absent once it is merged or closed). */
type MergeView = ReturnType<typeof forksApi.mergeRequestView>;
type OpenDetails = Extract<NonNullable<MergeView["open"]>, { diff: unknown }>;
const details = (view: MergeView): OpenDetails => {
  if (!view.open || !("diff" in view.open)) throw new Error("expected an open, available merge request");
  return view.open as OpenDetails;
};
const approve = (id: string, who = editor) =>
  as(who, () => forksApi.reviewMergeRequest(id, { decision: "approve", note: "" }));

describe("forking", () => {
  it("copies the collection without credentials and remembers its parent", () => {
    const { parent, fork } = setup("Forking");
    expect(fork).toMatchObject({
      status: "in-sync",
      ahead: 0,
      behind: 0,
      parentName: "Forking",
      workspaceId: wsF,
    });
    const copy = repo.getRequest(requestNamed(fork.folderId, "List")!)!;
    expect(copy.url).toBe("{{base}}/items");
    expect(copy.headers[0].value).toBe("");
    expect(repo.getFolder(fork.folderId)?.name).toBe("Forking (fork)");
    expect(repo.listVariables(wsF, "collection", fork.folderId)[0]).toMatchObject({ key: "base" });
    expect(as(owner, () => forksApi.listForksOf(parent)).map((f) => f.id)).not.toContain(fork.id); // owner cannot read wsF
    expect(as(forker, () => forksApi.listForksOf(parent)).map((f) => f.id)).toContain(fork.id);
  });

  it("needs read access to the parent and write access to the destination", () => {
    const parent = as(owner, () => repo.createFolder(wsP, null, { name: "Private" })).id;
    expect(() => as(outsider, () => forksApi.forkCollection(parent, { workspaceId: wsF }))).toThrow(
      /not found/i,
    );
    const outsiderWs = as(outsider, () => repo.createWorkspace("Elsewhere")).id;
    expect(() => as(outsider, () => forksApi.forkCollection(parent, { workspaceId: outsiderWs }))).toThrow(
      /not found/i,
    );
    expect(() => as(viewer, () => forksApi.forkCollection(parent, { workspaceId: wsP }))).toThrow(
      /Insufficient/,
    );
    const sub = as(owner, () => repo.createFolder(wsP, parent, { name: "Sub" })).id;
    expect(() => as(owner, () => forksApi.forkCollection(sub, { workspaceId: wsP }))).toThrow(
      /whole collection/,
    );
  });

  it("reports ahead, behind and diverged", () => {
    const { parent, fork } = setup("Status");
    edit(forker, fork.folderId, "List", { description: "mine" });
    expect(as(forker, () => forksApi.getFork(fork.id))).toMatchObject({
      status: "ahead",
      ahead: 1,
      behind: 0,
    });
    edit(owner, parent, "Drop", { description: "theirs" });
    expect(as(forker, () => forksApi.getFork(fork.id))).toMatchObject({
      status: "diverged",
      ahead: 1,
      behind: 1,
    });
  });
});

describe("syncing from the parent", () => {
  it("brings in the parent's changes and keeps the fork's own", () => {
    const { parent, fork } = setup("Sync");
    edit(forker, fork.folderId, "List", { description: "fork note" });
    edit(owner, parent, "Drop", { description: "parent note" });
    as(owner, () => repo.createRequest(wsP, parent, { name: "Added upstream" }));
    const preview = as(forker, () => forksApi.previewSync(fork.id));
    expect(preview.diff.added.map((n) => n.path)).toEqual(["Added upstream"]);
    expect(preview.plan.conflicts).toBe(0);
    const result = as(forker, () => forksApi.syncFork(fork.id, "abort"));
    expect(result.applied).toMatchObject({ added: 1, updated: 1 });
    expect(requestNamed(fork.folderId, "Added upstream")).toBeTruthy();
    expect(repo.getRequest(requestNamed(fork.folderId, "Drop")!)?.description).toBe("parent note");
    expect(repo.getRequest(requestNamed(fork.folderId, "List")!)?.description).toBe("fork note");
    expect(result.fork).toMatchObject({ status: "ahead", behind: 0 });
  });

  it("stops on a node both sides changed, then settles it either way", () => {
    const { parent, fork } = setup("SyncConflict");
    edit(forker, fork.folderId, "List", { description: "fork" });
    edit(owner, parent, "List", { description: "parent" });
    expect(() => as(forker, () => forksApi.syncFork(fork.id, "abort"))).toThrow(/conflict/);
    expect(repo.getRequest(requestNamed(fork.folderId, "List")!)?.description).toBe("fork");
    as(forker, () => forksApi.syncFork(fork.id, "take-incoming"));
    expect(repo.getRequest(requestNamed(fork.folderId, "List")!)?.description).toBe("parent");
  });

  it("reports an unavailable parent", () => {
    const { parent, fork } = setup("Orphan");
    as(owner, () => repo.deleteFolder(parent));
    expect(as(forker, () => forksApi.getFork(fork.id)).status).toBe("parent-unavailable");
    expect(() => as(forker, () => forksApi.previewSync(fork.id))).toThrow(/no longer available/);
    expect(repo.getFolder(fork.folderId)).toBeTruthy();
  });
});

describe("merge requests", () => {
  it("needs changes, allows one open request, and requires access to the parent", () => {
    const { fork } = setup("Opening");
    expect(() => openMr(fork.id)).toThrow(/no changes/);
    edit(forker, fork.folderId, "List", { description: "better" });
    const mr = openMr(fork.id);
    expect(mr).toMatchObject({ status: "open", title: "Improve it" });
    expect(details(mr).diff.changed.map((n) => n.path)).toEqual(["List"]);
    expect(() => openMr(fork.id, "Again")).toThrow(/already has an open/);
    expect(() =>
      as(outsider, () => forksApi.openMergeRequest(fork.id, { title: "x", description: "" })),
    ).toThrow(/not found/i);
  });

  it("is reviewed and merged by someone else, changing the parent and keeping its credentials", () => {
    const { parent, fork } = setup("Lifecycle");
    edit(forker, fork.folderId, "List", { description: "paged", url: "{{base}}/items?page=1" });
    as(forker, () => repo.createRequest(wsF, fork.folderId, { name: "Brand new", url: "{{base}}/new" }));
    const mr = openMr(fork.id);

    // Not yet: nothing approved, and the author's own approval does not count.
    expect(() => as(editor, () => forksApi.mergeMergeRequest(mr.id))).toThrow(/approval/);
    expect(() =>
      as(forker, () => forksApi.reviewMergeRequest(mr.id, { decision: "approve", note: "" })),
    ).toThrow(/Insufficient/);
    approve(mr.id);
    const merged = as(editor, () => forksApi.mergeMergeRequest(mr.id));
    expect(merged.mergeRequest).toMatchObject({ status: "merged", mergedByName: "editor" });

    const list = repo.getRequest(requestNamed(parent, "List")!)!;
    expect(list.description).toBe("paged");
    expect(list.url).toBe("{{base}}/items?page=1");
    // The parent's own credential survived a merge that touched the same request.
    expect(list.headers[0].value).toBe("Bearer parent-secret");
    expect(requestNamed(parent, "Brand new")).toBeTruthy();
    // The collection keeps its own name.
    expect(repo.getFolder(parent)?.name).toBe("Lifecycle");

    // The fork now agrees with the parent, and a follow-up change reaches the node it created.
    expect(as(forker, () => forksApi.getFork(fork.id))).toMatchObject({
      status: "in-sync",
      openMergeRequestId: null,
    });
    edit(forker, fork.folderId, "Brand new", { description: "second round" });
    const second = openMr(fork.id, "Round two");
    approve(second.id);
    as(editor, () => forksApi.mergeMergeRequest(second.id));
    expect(repo.getRequest(requestNamed(parent, "Brand new")!)?.description).toBe("second round");
    expect(
      as(owner, () => repo.getFolderTree(parent))!.children.filter((c) => c.name === "Brand new"),
    ).toHaveLength(1);
  });

  it("carries deletions across", () => {
    const { parent, fork } = setup("Deletions");
    as(forker, () => repo.deleteRequest(requestNamed(fork.folderId, "List")!));
    const mr = openMr(fork.id);
    approve(mr.id);
    as(editor, () => forksApi.mergeMergeRequest(mr.id));
    expect(requestNamed(parent, "List")).toBeNull();
    expect(requestNamed(parent, "Drop")).toBeTruthy();
  });

  it("makes approvals go stale when the fork changes afterwards", () => {
    const { fork } = setup("Stale");
    edit(forker, fork.folderId, "List", { description: "v1" });
    const mr = openMr(fork.id);
    approve(mr.id);
    edit(forker, fork.folderId, "List", { description: "v2 (sneaky)" });
    const view = as(editor, () => forksApi.getMergeRequest(mr.id));
    expect([details(view).approvals, details(view).staleReviews]).toEqual([0, 1]);
    expect(() => as(editor, () => forksApi.mergeMergeRequest(mr.id))).toThrow(/approval/);
    approve(mr.id);
    expect(as(editor, () => forksApi.mergeMergeRequest(mr.id)).mergeRequest.status).toBe("merged");
  });

  it("blocks on a rejection until the fork changes and is approved again", () => {
    const { fork } = setup("Rejected");
    edit(forker, fork.folderId, "List", { description: "first try" });
    const mr = openMr(fork.id);
    approve(mr.id);
    as(owner, () => forksApi.reviewMergeRequest(mr.id, { decision: "reject", note: "Please add tests" }));
    expect(() => as(owner, () => forksApi.mergeMergeRequest(mr.id))).toThrow(/asked for changes/);
    edit(forker, fork.folderId, "List", { description: "second try" });
    approve(mr.id);
    expect(as(editor, () => forksApi.mergeMergeRequest(mr.id)).mergeRequest.status).toBe("merged");
  });

  it("reserves script and example changes for owners", () => {
    const { parent, fork } = setup("Protected");
    edit(forker, fork.folderId, "List", { testScript: "pm.test('x', () => {})" });
    const mr = openMr(fork.id);
    approve(mr.id);
    const view = as(editor, () => forksApi.getMergeRequest(mr.id));
    expect(details(view).protectedChanges.map((c) => c.path)).toEqual(["List"]);
    expect(() => as(editor, () => forksApi.mergeMergeRequest(mr.id))).toThrow(/only a workspace owner/);
    expect(repo.getRequest(requestNamed(parent, "List")!)?.testScript).toBe("");
    as(owner, () => forksApi.mergeMergeRequest(mr.id));
    expect(repo.getRequest(requestNamed(parent, "List")!)?.testScript).toBe("pm.test('x', () => {})");
  });

  it("refuses to overwrite edits made to the parent since the fork", () => {
    const { parent, fork } = setup("Concurrent");
    edit(forker, fork.folderId, "List", { description: "fork's idea" });
    const mr = openMr(fork.id);
    approve(mr.id);
    edit(owner, parent, "List", { description: "someone else got there first" });
    const view = as(editor, () => forksApi.getMergeRequest(mr.id));
    expect(details(view).conflicts.map((c) => c.path)).toEqual(["List"]);
    expect(() => as(owner, () => forksApi.mergeMergeRequest(mr.id))).toThrow(/conflict/);
    expect(repo.getRequest(requestNamed(parent, "List")!)?.description).toBe("someone else got there first");
    // Resolving it on the fork side clears the way.
    as(forker, () => forksApi.syncFork(fork.id, "take-incoming"));
    expect(as(forker, () => forksApi.getFork(fork.id)).ahead).toBe(0);
    expect(() => as(owner, () => forksApi.mergeMergeRequest(mr.id))).toThrow(/nothing to merge/i);
  });

  it("merges non-overlapping parent and fork changes together", () => {
    const { parent, fork } = setup("Parallel");
    edit(forker, fork.folderId, "List", { description: "fork side" });
    const mr = openMr(fork.id);
    approve(mr.id);
    edit(owner, parent, "Drop", { description: "parent side" });
    as(editor, () => forksApi.mergeMergeRequest(mr.id));
    expect(repo.getRequest(requestNamed(parent, "List")!)?.description).toBe("fork side");
    expect(repo.getRequest(requestNamed(parent, "Drop")!)?.description).toBe("parent side");
    // The fork has not seen the parent's change yet, and does not undo it.
    expect(as(forker, () => forksApi.getFork(fork.id))).toMatchObject({ ahead: 0, behind: 1 });
  });

  it("enforces who may merge, close and look", () => {
    const { fork } = setup("Permissions");
    edit(forker, fork.folderId, "List", { description: "x" });
    const mr = openMr(fork.id);
    approve(mr.id);
    expect(() => as(viewer, () => forksApi.mergeMergeRequest(mr.id))).toThrow(/Insufficient/);
    expect(() => as(outsider, () => forksApi.mergeMergeRequest(mr.id))).toThrow(/not found/i);
    expect(() => as(outsider, () => forksApi.getMergeRequest(mr.id))).toThrow(/not found/i);
    expect(() => as(editor, () => forksApi.closeMergeRequest(mr.id, ""))).toThrow(
      /author or a workspace owner/,
    );
    as(editor, () => forksApi.mergeMergeRequest(mr.id));
    expect(() => as(editor, () => forksApi.mergeMergeRequest(mr.id))).toThrow(/already merged/);
    expect(() =>
      as(editor, () => forksApi.reviewMergeRequest(mr.id, { decision: "approve", note: "" })),
    ).toThrow(/already merged/);
  });

  it("lets the author close their own request, which then cannot be merged", () => {
    const { fork } = setup("Closing");
    edit(forker, fork.folderId, "List", { description: "x" });
    const mr = openMr(fork.id);
    const closed = as(forker, () => forksApi.closeMergeRequest(mr.id, "Changed my mind"));
    expect(closed).toMatchObject({ status: "closed", closedNote: "Changed my mind" });
    expect(() => as(owner, () => forksApi.mergeMergeRequest(mr.id))).toThrow(/already closed/);
    // A new request can be opened afterwards.
    expect(openMr(fork.id, "Take two").status).toBe("open");
  });

  it("lists requests for both the reviewing and the proposing workspace", () => {
    const { fork } = setup("Listing");
    edit(forker, fork.folderId, "List", { description: "x" });
    const mr = openMr(fork.id);
    expect(as(editor, () => forksApi.listMergeRequests(wsP, "open")).find((m) => m.id === mr.id)?.role).toBe(
      "parent",
    );
    expect(as(forker, () => forksApi.listMergeRequests(wsF)).find((m) => m.id === mr.id)?.role).toBe("fork");
  });

  it("supports discussion on a merge request and removes it with the fork", () => {
    const { fork } = setup("Discussion");
    edit(forker, fork.folderId, "List", { description: "x" });
    const mr = openMr(fork.id);
    as(editor, () =>
      comments.createComment({
        targetKind: "mergeRequest",
        targetId: mr.id,
        body: "Looks good @forker",
        parentId: null,
      }),
    );
    expect(as(forker, () => comments.listComments("mergeRequest", mr.id)).threads).toHaveLength(1);
    as(forker, () => forksApi.removeFork(fork.id, true));
    expect(repo.getFolder(fork.folderId)).toBeNull();
    const left = getSqlite().prepare("SELECT COUNT(*) AS n FROM comments WHERE target_id = ?").get(mr.id) as {
      n: number;
    };
    expect(left.n).toBe(0);
    expect(() => as(editor, () => forksApi.getMergeRequest(mr.id))).toThrow(/not found/i);
  });

  it("drops the fork when its collection is deleted", () => {
    const { fork } = setup("Gone");
    repo.deleteFolder(fork.folderId);
    expect(() => as(forker, () => forksApi.getFork(fork.id))).toThrow(/not found/i);
  });
});
