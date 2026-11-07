import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Caller } from "@/server/caller";
import type { UserRow } from "@/server/db/schema";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-specforks-"));
process.env.DATABASE_PATH = path.join(dir, "test.db");
const { getSqlite } = await import("@/server/db");
const users = await import("@/server/users");
const repo = await import("@/server/repo");
const { withCaller } = await import("@/server/access-context");
const { setMember } = await import("@/server/authorize");
const forks = await import("@/server/forks");
const specForks = await import("@/server/spec-forks");
const specs = await import("@/server/specifications");
const comments = await import("@/server/comments");
const caller = (user: UserRow): Caller => ({ kind: "user", user, via: "session" });
const as = <T>(u: UserRow, fn: () => T) => withCaller(caller(u), fn);

let owner: UserRow, editor: UserRow, viewer: UserRow, forker: UserRow, outsider: UserRow;
let wsP: string, wsF: string;

beforeAll(async () => {
  repo.createWorkspace("Before accounts");
  await users.createUser({ username: "admin", password: "password123", isAdmin: true });
  for (const n of ["owner", "editor", "viewer", "forker", "outsider"])
    await users.createUser({ username: n, password: "password123" });
  const get = (n: string) => users.getUserByUsername(n)!;
  [owner, editor, viewer, forker, outsider] = ["owner", "editor", "viewer", "forker", "outsider"].map(get);
  wsP = as(owner, () => repo.createWorkspace("Spec team")).id;
  as(owner, () => {
    setMember(wsP, editor.username, "editor");
    setMember(wsP, viewer.username, "viewer");
    setMember(wsP, forker.username, "viewer");
  });
  wsF = as(forker, () => repo.createWorkspace("Forker specs")).id;
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const yaml = (t: string) => `openapi: 3.0.0\ninfo:\n  title: ${t}\n  version: "1"\npaths: {}\n`;
function setup(name: string) {
  const parent = as(owner, () =>
    specs.createSpecification({
      workspaceId: wsP,
      name,
      format: "openapi",
      entrypoint: "openapi.yaml",
      files: [
        { path: "openapi.yaml", content: yaml("v1") },
        { path: "schemas/pet.yaml", content: "type: object\n" },
      ],
      label: "first",
    }),
  ).id;
  const fork = as(forker, () => specForks.forkSpecification(parent, { workspaceId: wsF }));
  return { parent, fork };
}
const saveFile = (u: UserRow, id: string, filePath: string, content: string | null) => {
  const cur = as(u, () => specs.getSpecification(id));
  const files = cur.files.filter((f) => f.path !== filePath);
  if (content !== null) files.push({ path: filePath, content });
  return as(u, () =>
    specs.saveSpecification(id, {
      expectedRevision: cur.revision,
      entrypoint: cur.entrypoint,
      files,
      label: "edit",
    }),
  );
};
const contentOf = (id: string, filePath: string) =>
  specs.getSpecification(id).files.find((f) => f.path === filePath)?.content;
const openMr = (forkId: string, title = "Improve spec") =>
  as(forker, () => forks.openMergeRequest(forkId, { title, description: "" }));
const approve = (id: string, who = editor) =>
  as(who, () => forks.reviewMergeRequest(id, { decision: "approve", note: "" }));
type MergeView = ReturnType<typeof forks.mergeRequestView>;
const details = (v: MergeView) => {
  if (!v.open || !("diff" in v.open)) throw new Error("expected open details");
  return v.open as Extract<NonNullable<MergeView["open"]>, { diff: unknown }>;
};

describe("forking a specification", () => {
  it("copies the sources and remembers the parent", () => {
    const { parent, fork } = setup("Forking");
    expect(fork).toMatchObject({
      kind: "specification",
      status: "in-sync",
      ahead: 0,
      behind: 0,
      parentName: "Forking",
      workspaceId: wsF,
    });
    const copy = specs.getSpecification(fork.folderId);
    expect(copy.name).toBe("Forking (fork)");
    expect(copy.files.map((f) => f.path).sort()).toEqual(["openapi.yaml", "schemas/pet.yaml"]);
    expect(as(forker, () => specForks.listSpecForksOf(parent)).map((f) => f.id)).toContain(fork.id);
    expect(as(owner, () => specForks.listSpecForksOf(parent)).map((f) => f.id)).not.toContain(fork.id);
    // Spec forks show up in the workspace list but not among a collection's forks.
    expect(as(forker, () => forks.listForks(wsF)).map((f) => f.id)).toContain(fork.id);
  });

  it("needs read access to the original and write access to the destination", () => {
    const { parent } = setup("Access");
    expect(() => as(outsider, () => specForks.forkSpecification(parent, { workspaceId: wsF }))).toThrow(
      /not found/i,
    );
    expect(() => as(viewer, () => specForks.forkSpecification(parent, { workspaceId: wsP }))).toThrow(
      /Insufficient/,
    );
  });

  it("reports ahead, behind and diverged", () => {
    const { parent, fork } = setup("Status");
    saveFile(forker, fork.folderId, "schemas/pet.yaml", "type: object\nrequired: [id]\n");
    expect(as(forker, () => forks.getFork(fork.id))).toMatchObject({ status: "ahead", ahead: 1, behind: 0 });
    saveFile(owner, parent, "openapi.yaml", yaml("v2"));
    expect(as(forker, () => forks.getFork(fork.id))).toMatchObject({
      status: "diverged",
      ahead: 1,
      behind: 1,
    });
  });
});

describe("syncing a specification fork", () => {
  it("brings upstream file changes in and keeps the fork's own", () => {
    const { parent, fork } = setup("Sync");
    saveFile(forker, fork.folderId, "schemas/pet.yaml", "type: object\n# mine\n");
    saveFile(owner, parent, "openapi.yaml", yaml("upstream"));
    saveFile(owner, parent, "schemas/owner.yaml", "type: object\n");
    const preview = as(forker, () => forks.previewSync(fork.id));
    expect(preview.diff.added.map((n) => n.path)).toEqual(["schemas/owner.yaml"]);
    expect(preview.plan.conflicts).toBe(0);
    const r = as(forker, () => forks.syncFork(fork.id, "abort"));
    expect(r.applied).toMatchObject({ added: 1, updated: 1 });
    expect(contentOf(fork.folderId, "openapi.yaml")).toBe(yaml("upstream"));
    expect(contentOf(fork.folderId, "schemas/pet.yaml")).toBe("type: object\n# mine\n");
    expect(r.fork).toMatchObject({ status: "ahead", behind: 0 });
  });

  it("stops on a file both sides changed, then settles it either way", () => {
    const { parent, fork } = setup("SyncConflict");
    saveFile(forker, fork.folderId, "openapi.yaml", yaml("fork"));
    saveFile(owner, parent, "openapi.yaml", yaml("parent"));
    expect(() => as(forker, () => forks.syncFork(fork.id, "abort"))).toThrow(/conflict/);
    expect(contentOf(fork.folderId, "openapi.yaml")).toBe(yaml("fork"));
    as(forker, () => forks.syncFork(fork.id, "take-incoming"));
    expect(contentOf(fork.folderId, "openapi.yaml")).toBe(yaml("parent"));
  });
});

describe("specification merge requests", () => {
  it("is reviewed and merged as the next revision of the original", () => {
    const { parent, fork } = setup("Lifecycle");
    saveFile(forker, fork.folderId, "schemas/pet.yaml", "type: object\nrequired: [id]\n");
    saveFile(forker, fork.folderId, "schemas/new.yaml", "type: string\n");
    const mr = openMr(fork.id);
    expect(mr).toMatchObject({ status: "open" });
    expect(details(mr).diff.added.map((n) => n.path)).toEqual(["schemas/new.yaml"]);
    expect(details(mr).diff.changed.map((n) => n.path)).toEqual(["schemas/pet.yaml"]);
    expect(() => openMr(fork.id, "again")).toThrow(/already has an open/);

    expect(() => as(editor, () => forks.mergeMergeRequest(mr.id))).toThrow(/approval/);
    expect(() =>
      as(forker, () => forks.reviewMergeRequest(mr.id, { decision: "approve", note: "" })),
    ).toThrow(/Insufficient/);
    approve(mr.id);
    const before = specs.getSpecification(parent).revision;
    const merged = as(editor, () => forks.mergeMergeRequest(mr.id));
    expect(merged.mergeRequest).toMatchObject({ status: "merged" });
    const now = specs.getSpecification(parent);
    expect(now.revision).toBe(before + 1);
    expect(now.label).toBe("Merged: Improve spec");
    expect(contentOf(parent, "schemas/pet.yaml")).toBe("type: object\nrequired: [id]\n");
    expect(contentOf(parent, "schemas/new.yaml")).toBe("type: string\n");
    expect(now.name).toBe("Lifecycle");
    expect(as(forker, () => forks.getFork(fork.id))).toMatchObject({
      status: "in-sync",
      openMergeRequestId: null,
    });
    // A second round merges again on top.
    saveFile(forker, fork.folderId, "schemas/new.yaml", "type: integer\n");
    const second = openMr(fork.id, "Round two");
    approve(second.id);
    as(editor, () => forks.mergeMergeRequest(second.id));
    expect(contentOf(parent, "schemas/new.yaml")).toBe("type: integer\n");
  });

  it("carries removals across and merges alongside unrelated upstream changes", () => {
    const { parent, fork } = setup("Parallel");
    saveFile(forker, fork.folderId, "schemas/pet.yaml", null);
    const mr = openMr(fork.id);
    approve(mr.id);
    saveFile(owner, parent, "openapi.yaml", yaml("meanwhile"));
    as(editor, () => forks.mergeMergeRequest(mr.id));
    expect(contentOf(parent, "schemas/pet.yaml")).toBeUndefined();
    expect(contentOf(parent, "openapi.yaml")).toBe(yaml("meanwhile"));
    expect(as(forker, () => forks.getFork(fork.id))).toMatchObject({ ahead: 0, behind: 1 });
  });

  it("goes stale when the fork changes, blocks on rejections, and never overwrites the original", () => {
    const { parent, fork } = setup("Rules");
    saveFile(forker, fork.folderId, "schemas/pet.yaml", "type: object\n# v1\n");
    const mr = openMr(fork.id);
    approve(mr.id);
    saveFile(forker, fork.folderId, "schemas/pet.yaml", "type: object\n# v2 sneaky\n");
    expect(details(as(editor, () => forks.getMergeRequest(mr.id))).staleReviews).toBe(1);
    expect(() => as(editor, () => forks.mergeMergeRequest(mr.id))).toThrow(/approval/);
    as(owner, () => forks.reviewMergeRequest(mr.id, { decision: "reject", note: "needs work" }));
    expect(() => as(owner, () => forks.mergeMergeRequest(mr.id))).toThrow(/asked for changes/);
    saveFile(forker, fork.folderId, "schemas/pet.yaml", "type: object\n# v3\n");
    approve(mr.id);
    // Meanwhile the original changed the same file: the merge refuses and changes nothing.
    saveFile(owner, parent, "schemas/pet.yaml", "type: object\n# theirs\n");
    const view = details(as(editor, () => forks.getMergeRequest(mr.id)));
    expect(view.conflicts.map((c) => c.path)).toEqual(["schemas/pet.yaml"]);
    expect(() => as(owner, () => forks.mergeMergeRequest(mr.id))).toThrow(/conflict/);
    expect(contentOf(parent, "schemas/pet.yaml")).toBe("type: object\n# theirs\n");
  });

  it("enforces who may merge and close, and supports discussion and cleanup", () => {
    const { parent, fork } = setup("Permissions");
    saveFile(forker, fork.folderId, "schemas/pet.yaml", "type: object\n# x\n");
    const mr = openMr(fork.id);
    approve(mr.id);
    expect(() => as(viewer, () => forks.mergeMergeRequest(mr.id))).toThrow(/Insufficient/);
    expect(() => as(outsider, () => forks.getMergeRequest(mr.id))).toThrow(/not found/i);
    expect(() => as(editor, () => forks.closeMergeRequest(mr.id, ""))).toThrow(/author or a workspace owner/);
    as(editor, () =>
      comments.createComment({
        targetKind: "mergeRequest",
        targetId: mr.id,
        body: "Nice @forker",
        parentId: null,
      }),
    );
    expect(as(forker, () => comments.listComments("mergeRequest", mr.id)).threads).toHaveLength(1);
    as(forker, () => forks.closeMergeRequest(mr.id, "later"));
    expect(() => as(owner, () => forks.mergeMergeRequest(mr.id))).toThrow(/already closed/);
    expect(contentOf(parent, "schemas/pet.yaml")).toBe("type: object\n");
    // Deleting the fork's specification removes it, its requests and their discussion.
    as(forker, () => specs.deleteSpecification(fork.folderId));
    expect(() => as(forker, () => forks.getFork(fork.id))).toThrow(/not found/i);
    const left = getSqlite().prepare("SELECT COUNT(*) AS n FROM comments WHERE target_id = ?").get(mr.id) as {
      n: number;
    };
    expect(left.n).toBe(0);
  });

  it("reports an unavailable original and cleans up with the fork", () => {
    const { parent, fork } = setup("Orphan");
    as(owner, () => specs.deleteSpecification(parent));
    expect(as(forker, () => forks.getFork(fork.id)).status).toBe("parent-unavailable");
    expect(() => as(forker, () => forks.previewSync(fork.id))).toThrow(/no longer available/);
    as(forker, () => forks.removeFork(fork.id, true));
    expect(() => specs.getSpecification(fork.folderId)).toThrow(/not found/i);
  });
});
