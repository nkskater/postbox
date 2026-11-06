import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { eq } from "drizzle-orm";
import type { Caller } from "@/server/caller";
import type { UserRow } from "@/server/db/schema";
import {
  buildThreads,
  createCommentInput,
  extractMentions,
  sanitizeCommentBody,
} from "@/core/comments/model";

describe("comment rules", () => {
  it("strips markup and control characters but keeps plain text", () => {
    expect(sanitizeCommentBody("  hi <script>alert(1)</script> <b>there</b>\u0000\r\n ok ")).toBe(
      "hi alert(1) there\n ok",
    );
    expect(sanitizeCommentBody("a < b and c > d")).toBe("a < b and c > d");
  });
  it("extracts distinct lower-case mentions and ignores emails", () => {
    expect(extractMentions("cc @Alice and @bob.smith, @alice again; mail me@example.com @@x")).toEqual([
      "alice",
      "bob.smith",
    ]);
  });
  it("rejects empty or oversized bodies", () => {
    const base = { targetKind: "request", targetId: "r1" };
    expect(createCommentInput.safeParse({ ...base, body: " <i></i> " }).success).toBe(false);
    expect(createCommentInput.safeParse({ ...base, body: "x".repeat(4001) }).success).toBe(false);
    expect(createCommentInput.safeParse({ ...base, body: "fine" }).success).toBe(true);
  });
  it("builds threads oldest first with replies attached", () => {
    const c = (id: string, createdAt: number, parentId: string | null = null) =>
      ({ id, createdAt, parentId }) as never;
    const threads = buildThreads([
      c("r2", 4, "a"),
      c("b", 3),
      c("a", 1),
      c("r1", 2, "a"),
      c("orphan", 5, "gone"),
    ]);
    expect(threads.map((t) => t.id)).toEqual(["a", "b"]);
    expect(threads[0].replies!.map((r) => r.id)).toEqual(["r1", "r2"]);
  });
});

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-comments-"));
process.env.DATABASE_PATH = path.join(dir, "test.db");
const { getDb, schema } = await import("@/server/db");
const users = await import("@/server/users");
const repo = await import("@/server/repo");
const { withCaller } = await import("@/server/access-context");
const { setMember } = await import("@/server/authorize");
const svc = await import("@/server/comments");
const caller = (user: UserRow): Caller => ({ kind: "user", user, via: "session" });
const as = <T>(u: UserRow, fn: () => T) => withCaller(caller(u), fn);

let owner: UserRow, editor: UserRow, viewer: UserRow, outsider: UserRow;
let workspaceId: string, folderId: string, requestId: string, specId: string;

beforeAll(async () => {
  repo.createWorkspace("Before accounts");
  await users.createUser({ username: "admin", password: "password123", isAdmin: true });
  owner = await users.createUser({ username: "owner", password: "password123" });
  editor = await users.createUser({ username: "editor", password: "password123" });
  viewer = await users.createUser({ username: "viewer", password: "password123" });
  outsider = await users.createUser({ username: "outsider", password: "password123" });
  workspaceId = as(owner, () => repo.createWorkspace("Team")).id;
  as(owner, () => {
    setMember(workspaceId, editor.username, "editor");
    setMember(workspaceId, viewer.username, "viewer");
  });
  folderId = as(owner, () => repo.createFolder(workspaceId, null, { name: "Payments" })).id;
  requestId = as(owner, () => repo.createRequest(workspaceId, folderId, { name: "Charge" })).id;
  specId = "spec-1";
  getDb()
    .insert(schema.specifications)
    .values({ id: specId, workspaceId, name: "Spec", format: "graphql", createdAt: 1, updatedAt: 1 })
    .run();
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const post = (
  u: UserRow,
  body: string,
  parentId: string | null = null,
  kind: "request" | "folder" | "specification" = "request",
) =>
  as(u, () =>
    svc.createComment({
      targetKind: kind,
      targetId: kind === "request" ? requestId : kind === "folder" ? folderId : specId,
      body,
      parentId,
    }),
  );

describe("discussions", () => {
  it("lets viewers comment and records the revision, author and permissions", () => {
    const c = post(viewer, "Is this idempotent?");
    expect(c).toMatchObject({ authorName: "viewer", parentId: null, resolvedAt: null });
    expect(c.revision).toMatch(/^\d+$/);
    expect(c.can).toEqual({ edit: true, delete: true, resolve: true });
    expect(as(owner, () => svc.getComment(c.id)).can).toEqual({ edit: false, delete: true, resolve: true });
    expect(as(viewer, () => svc.listComments("request", requestId)).threads).toHaveLength(1);
  });

  it("hides discussions from people outside the workspace", () => {
    expect(() => as(outsider, () => svc.listComments("request", requestId))).toThrow(/not found/i);
    expect(() => post(outsider, "hello")).toThrow(/not found/i);
  });

  it("only attaches replies to top-level comments on the same element", () => {
    const root = post(editor, "Root");
    const reply = post(owner, "Reply", root.id);
    expect(reply.parentId).toBe(root.id);
    expect(() => post(owner, "Nested", reply.id)).toThrow(/top-level/);
    expect(() => post(owner, "Wrong element", root.id, "folder")).toThrow(/top-level/);
    const tree = as(owner, () => svc.listComments("request", requestId)).threads.find(
      (t) => t.id === root.id,
    )!;
    expect(tree.replies!.map((r) => r.body)).toEqual(["Reply"]);
  });

  it("stores comments as plain text", () => {
    const c = post(editor, "look <img src=x onerror=alert(1)> here");
    expect(c.body).toBe("look  here");
  });

  it("limits editing to the author and records the edit", () => {
    const c = post(editor, "Typo");
    expect(() => as(owner, () => svc.editComment(c.id, "Hijack"))).toThrow(/author/);
    const edited = as(editor, () => svc.editComment(c.id, "Fixed"));
    expect(edited.body).toBe("Fixed");
    expect(edited.editedAt).not.toBeNull();
  });

  it("resolves and reopens threads: author or editors, not other viewers", () => {
    const root = post(viewer, "Question");
    expect(() => as(outsider, () => svc.setResolved(root.id, true))).toThrow();
    const other = as(owner, () => svc.setResolved(root.id, true));
    expect(other.resolvedAt).not.toBeNull();
    expect(other.resolvedBy).toBe("owner");
    expect(as(viewer, () => svc.setResolved(root.id, false)).resolvedAt).toBeNull();
    const editorsRoot = post(editor, "Mine");
    expect(() => as(viewer, () => svc.setResolved(editorsRoot.id, true))).toThrow(/author or an editor/);
    const reply = post(owner, "r", root.id);
    expect(() => as(owner, () => svc.setResolved(reply.id, true))).toThrow(/thread/);
  });

  it("counts open threads per element and can filter resolved ones", () => {
    const counts = as(viewer, () => svc.openThreadCounts(workspaceId));
    const all = as(viewer, () => svc.listComments("request", requestId));
    expect(counts[`request:${requestId}`]).toBe(all.openThreads);
    const open = as(viewer, () => svc.listComments("request", requestId, false));
    expect(open.threads.every((t) => !t.resolvedAt)).toBe(true);
  });

  it("deletes: authors and owners, never an editor's colleague; threads take replies along", () => {
    const root = post(editor, "To go");
    post(viewer, "reply 1", root.id);
    expect(() => as(viewer, () => svc.deleteComment(root.id))).toThrow(/author or a workspace owner/);
    expect(as(editor, () => svc.deleteComment(root.id))).toEqual({ deleted: 2 });
    const other = post(viewer, "Owner removes");
    expect(as(owner, () => svc.deleteComment(other.id))).toEqual({ deleted: 1 });
    expect(() => as(owner, () => svc.getComment(other.id))).toThrow(/not found/i);
  });

  it("works on folders and specifications too", () => {
    post(editor, "On the collection", null, "folder");
    post(editor, "On the spec", null, "specification");
    expect(as(viewer, () => svc.listComments("folder", folderId)).threads).toHaveLength(1);
    expect(as(viewer, () => svc.listComments("specification", specId)).threads).toHaveLength(1);
    expect(() => as(viewer, () => svc.listComments("request", "nope"))).toThrow(/does not exist/);
  });

  it("refuses a read-only API key", () => {
    const readKey: Caller = {
      kind: "user",
      user: editor,
      via: "token",
      token: { id: "t", scope: "read", rateLimitPerMinute: null },
    };
    expect(() =>
      withCaller(readKey, () =>
        svc.createComment({ targetKind: "request", targetId: requestId, body: "sneaky", parentId: null }),
      ),
    ).toThrow(/scope/);
    expect(withCaller(readKey, () => svc.listComments("request", requestId)).threads.length).toBeGreaterThan(
      0,
    );
  });
});

describe("mentions and notifications", () => {
  it("notifies people who can read the workspace, ignores strangers and the author", () => {
    const c = post(editor, "ping @owner @outsider @editor @nobody");
    expect(c.mentions).toEqual(["owner", "editor"]);
    const mine = as(owner, () => svc.listNotifications(true));
    const n = mine.notifications.find((x) => x.comment.id === c.id)!;
    expect(n.kind).toBe("mention");
    expect(as(outsider, () => svc.listNotifications()).notifications).toHaveLength(0);
    expect(as(editor, () => svc.listNotifications()).notifications.some((x) => x.comment.id === c.id)).toBe(
      false,
    );
  });

  it("tells a thread's author about replies, and mentions win over replies", () => {
    const root = post(viewer, "Question");
    post(owner, "Answer", root.id);
    const first = as(viewer, () => svc.listNotifications(true)).notifications.filter(
      (x) => x.comment.parentId === root.id,
    );
    expect(first.map((x) => x.kind)).toEqual(["reply"]);
    post(editor, "also @viewer", root.id);
    const kinds = as(viewer, () => svc.listNotifications(true))
      .notifications.filter((x) => x.comment.parentId === root.id)
      .map((x) => x.kind)
      .sort();
    expect(kinds).toEqual(["mention", "reply"]);
  });

  it("re-notifies only people newly mentioned by an edit", () => {
    const c = post(editor, "hello @viewer");
    const count = () =>
      as(viewer, () => svc.listNotifications()).notifications.filter((x) => x.comment.id === c.id).length;
    expect(count()).toBe(1);
    as(editor, () => svc.editComment(c.id, "hello @viewer, and @owner"));
    expect(count()).toBe(1);
    expect(as(owner, () => svc.listNotifications()).notifications.some((x) => x.comment.id === c.id)).toBe(
      true,
    );
  });

  it("marks notifications read, one at a time or all", () => {
    const before = as(owner, () => svc.listNotifications(true));
    expect(before.unread).toBeGreaterThan(1);
    const one = before.notifications[0].id;
    expect(as(owner, () => svc.markNotificationsRead([one]))).toEqual({ updated: 1 });
    expect(as(owner, () => svc.listNotifications(true)).unread).toBe(before.unread - 1);
    as(owner, () => svc.markNotificationsRead());
    expect(as(owner, () => svc.listNotifications(true)).unread).toBe(0);
    expect(as(viewer, () => svc.markNotificationsRead([one]))).toEqual({ updated: 0 });
  });

  it("stops showing notifications once access is removed", () => {
    const c = post(owner, "for @viewer only");
    expect(
      as(viewer, () => svc.listNotifications(true)).notifications.some((x) => x.comment.id === c.id),
    ).toBe(true);
    as(owner, () => setMember(workspaceId, viewer.username, null));
    expect(as(viewer, () => svc.listNotifications()).notifications).toHaveLength(0);
    as(owner, () => setMember(workspaceId, viewer.username, "viewer"));
  });

  it("lists who can be mentioned without leaking passwords or outsiders", () => {
    const names = as(viewer, () => svc.listMentionable(workspaceId)).map((u) => u.username);
    expect(names).toEqual(expect.arrayContaining(["admin", "owner", "editor", "viewer"]));
    expect(names).not.toContain("outsider");
    expect(JSON.stringify(as(viewer, () => svc.listMentionable(workspaceId)))).not.toMatch(/hash|password"/i);
  });
});

describe("cleanup", () => {
  it("removes discussions with their request, folder or specification", () => {
    const folder = as(owner, () => repo.createFolder(workspaceId, null, { name: "Temp" })).id;
    const req = as(owner, () => repo.createRequest(workspaceId, folder, { name: "T" })).id;
    for (const [targetKind, targetId] of [
      ["folder", folder],
      ["request", req],
    ] as const)
      as(owner, () => svc.createComment({ targetKind, targetId, body: "bye", parentId: null }));
    const left = () =>
      getDb().select().from(schema.comments).where(eq(schema.comments.workspaceId, workspaceId)).all();
    const before = left().length;
    as(owner, () => repo.deleteFolder(folder));
    expect(left().length).toBe(before - 2);
    const req2 = as(owner, () => repo.createRequest(workspaceId, folderId, { name: "T2" })).id;
    as(owner, () => svc.createComment({ targetKind: "request", targetId: req2, body: "x", parentId: null }));
    as(owner, () => repo.deleteRequest(req2));
    expect(left().length).toBe(before - 2);
  });
});
