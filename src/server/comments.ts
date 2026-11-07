import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  COMMENT_LIMITS,
  buildThreads,
  extractMentions,
  sanitizeCommentBody,
  type CommentTarget,
  type CommentView,
} from "@/core/comments/model";
import { currentCaller } from "./access-context";
import { authorize, requireScope, workspaceRole, ROLE_ACTIONS } from "./authorize";
import type { Caller } from "./caller";
import { newId } from "./defaults";
import { getDb, schema } from "./db";
import { HttpError } from "./errors";
import { assertStorage } from "./usage";

const { comments, commentNotifications: notes, users, workspaceMembers } = schema;
type CommentRow = typeof comments.$inferSelect;

/** The element a discussion hangs on: where it lives and what version it is at. */
function resolveTarget(kind: CommentTarget, id: string): { workspaceId: string; revision: string } {
  const db = getDb();
  if (kind === "request") {
    const r = db.select().from(schema.requests).where(eq(schema.requests.id, id)).get();
    if (r) return { workspaceId: r.workspaceId, revision: String(r.updatedAt) };
  } else if (kind === "folder") {
    const f = db.select().from(schema.folders).where(eq(schema.folders.id, id)).get();
    if (f) return { workspaceId: f.workspaceId, revision: String(f.updatedAt) };
  } else if (kind === "mergeRequest") {
    const m = db.select().from(schema.mergeRequests).where(eq(schema.mergeRequests.id, id)).get();
    if (m) return { workspaceId: m.workspaceId, revision: String(m.updatedAt) };
  } else {
    const s = db.select().from(schema.specifications).where(eq(schema.specifications.id, id)).get();
    if (s) return { workspaceId: s.workspaceId, revision: `v${s.revision}` };
  }
  throw new HttpError(404, "Nothing to discuss: that element does not exist");
}

const callerUser = (c: Caller | undefined) => (c?.kind === "user" ? c.user : null);

function authorOf(c: Caller | undefined): { id: string | null; name: string } {
  const u = callerUser(c);
  if (u) return { id: u.id, name: u.displayName || u.username };
  return { id: null, name: c?.kind === "env" ? "Administrator" : "Anonymous" };
}

const isAuthor = (c: Caller | undefined, row: CommentRow) => {
  const u = callerUser(c);
  return u ? row.authorId === u.id : row.authorId === null;
};

function view(row: CommentRow, c: Caller | undefined): CommentView {
  const role = workspaceRole(c, row.workspaceId);
  const can = (a: "write" | "manage") => !!role && ROLE_ACTIONS[role].includes(a);
  const mine = isAuthor(c, row);
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    targetKind: row.targetKind,
    targetId: row.targetId,
    parentId: row.parentId,
    body: row.body,
    authorId: row.authorId,
    authorName: row.authorName,
    mentions: row.mentions,
    revision: row.revision,
    resolvedAt: row.resolvedAt,
    resolvedBy: row.resolvedBy,
    createdAt: row.createdAt,
    editedAt: row.editedAt,
    can: { edit: mine, delete: mine || can("manage"), resolve: mine || can("write") },
  };
}

/** People in the workspace who can be @mentioned: members and administrators who may read it. */
export function listMentionable(workspaceId: string) {
  authorize(currentCaller(), workspaceId, "read");
  const db = getDb();
  const members = db
    .select({ id: users.id, username: users.username, displayName: users.displayName })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(users.disabled, false)))
    .all();
  const admins = db
    .select({ id: users.id, username: users.username, displayName: users.displayName })
    .from(users)
    .where(and(eq(users.isAdmin, true), eq(users.disabled, false)))
    .all();
  const seen = new Map<string, (typeof members)[number]>();
  for (const u of [...members, ...admins]) seen.set(u.id, u);
  return [...seen.values()].sort((a, b) => a.username.localeCompare(b.username));
}

export function listComments(targetKind: CommentTarget, targetId: string, includeResolved = true) {
  const caller = currentCaller();
  const { workspaceId } = resolveTarget(targetKind, targetId);
  authorize(caller, workspaceId, "read");
  const rows = getDb()
    .select()
    .from(comments)
    .where(and(eq(comments.targetKind, targetKind), eq(comments.targetId, targetId)))
    .orderBy(asc(comments.createdAt), asc(comments.id))
    .all();
  const threads = buildThreads(rows.map((r) => view(r, caller)));
  const open = threads.filter((t) => !t.resolvedAt).length;
  return {
    threads: includeResolved ? threads : threads.filter((t) => !t.resolvedAt),
    openThreads: open,
    resolvedThreads: threads.length - open,
  };
}

/** How many unresolved threads each element has, so lists can show a badge without loading discussions. */
export function openThreadCounts(workspaceId: string): Record<string, number> {
  authorize(currentCaller(), workspaceId, "read");
  const rows = getDb()
    .select({ kind: comments.targetKind, id: comments.targetId, n: sql<number>`count(*)` })
    .from(comments)
    .where(and(eq(comments.workspaceId, workspaceId), isNull(comments.parentId), isNull(comments.resolvedAt)))
    .groupBy(comments.targetKind, comments.targetId)
    .all();
  return Object.fromEntries(rows.map((r) => [`${r.kind}:${r.id}`, r.n]));
}

export function createComment(input: {
  targetKind: CommentTarget;
  targetId: string;
  body: string;
  parentId: string | null;
}): CommentView {
  const caller = currentCaller();
  const target = resolveTarget(input.targetKind, input.targetId);
  // Viewers may take part in a discussion; a key that is read-only may not.
  authorize(caller, target.workspaceId, "read");
  requireScope(caller, "write");
  const db = getDb();
  const body = sanitizeCommentBody(input.body);
  if (!body) throw new HttpError(400, "Comment is empty");
  let parent: CommentRow | undefined;
  if (input.parentId) {
    parent = db.select().from(comments).where(eq(comments.id, input.parentId)).get();
    if (
      !parent ||
      parent.targetKind !== input.targetKind ||
      parent.targetId !== input.targetId ||
      parent.parentId
    )
      throw new HttpError(400, "Replies must answer a top-level comment on the same element");
  }
  const total = db
    .select({ n: sql<number>`count(*)` })
    .from(comments)
    .where(and(eq(comments.targetKind, input.targetKind), eq(comments.targetId, input.targetId)))
    .get()!.n;
  if (total >= COMMENT_LIMITS.perTarget)
    throw new HttpError(409, `This element already has ${COMMENT_LIMITS.perTarget} comments`);
  assertStorage(target.workspaceId);

  const author = authorOf(caller);
  const mentioned = resolveMentions(body, target.workspaceId);
  const row: CommentRow = {
    id: newId(),
    workspaceId: target.workspaceId,
    targetKind: input.targetKind,
    targetId: input.targetId,
    parentId: parent?.id ?? null,
    body,
    authorId: author.id,
    authorName: author.name,
    mentions: mentioned.map((u) => u.username),
    revision: target.revision,
    resolvedAt: null,
    resolvedBy: null,
    editedAt: null,
    createdAt: Date.now(),
  };
  db.transaction((tx) => {
    tx.insert(comments).values(row).run();
    notify(tx, row, mentioned, parent);
  });
  return view(row, caller);
}

/** Mentioned usernames that name someone who can read this workspace (anyone else is just text). */
function resolveMentions(body: string, workspaceId: string) {
  const names = extractMentions(body);
  if (!names.length) return [];
  const people = new Map(listMentionable(workspaceId).map((u) => [u.username.toLowerCase(), u]));
  return names.flatMap((n) => (people.has(n) ? [people.get(n)!] : []));
}

type Tx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];
function notify(
  tx: Tx,
  row: CommentRow,
  mentioned: { id: string; username: string }[],
  parent: CommentRow | undefined,
  only?: Set<string>,
) {
  const recipients = new Map<string, "mention" | "reply">();
  for (const u of mentioned) recipients.set(u.id, "mention");
  if (parent?.authorId && !recipients.has(parent.authorId)) recipients.set(parent.authorId, "reply");
  for (const [userId, kind] of recipients) {
    if (userId === row.authorId) continue;
    if (only && !only.has(userId)) continue;
    tx.insert(notes)
      .values({ id: newId(), userId, commentId: row.id, kind, readAt: null, createdAt: Date.now() })
      .run();
  }
}

function requireComment(id: string): CommentRow {
  const row = getDb().select().from(comments).where(eq(comments.id, id)).get();
  if (!row) throw new HttpError(404, "Comment not found");
  authorize(currentCaller(), row.workspaceId, "read");
  return row;
}

export function getComment(id: string): CommentView {
  return view(requireComment(id), currentCaller());
}

export function editComment(id: string, rawBody: string): CommentView {
  const caller = currentCaller();
  const row = requireComment(id);
  requireScope(caller, "write");
  if (!isAuthor(caller, row)) throw new HttpError(403, "Only the author can edit a comment");
  const body = sanitizeCommentBody(rawBody);
  if (!body) throw new HttpError(400, "Comment is empty");
  const mentioned = resolveMentions(body, row.workspaceId);
  const fresh = mentioned.filter((u) => !row.mentions.includes(u.username));
  const next: CommentRow = { ...row, body, mentions: mentioned.map((u) => u.username), editedAt: Date.now() };
  getDb().transaction((tx) => {
    tx.update(comments)
      .set({ body, mentions: next.mentions, editedAt: next.editedAt })
      .where(eq(comments.id, id))
      .run();
    // Only people newly mentioned are told; editing a typo does not re-notify everyone.
    notify(tx, next, fresh, undefined);
  });
  return view(next, caller);
}

export function setResolved(id: string, resolved: boolean): CommentView {
  const caller = currentCaller();
  const row = requireComment(id);
  requireScope(caller, "write");
  if (row.parentId) throw new HttpError(400, "Resolve the thread, not a reply");
  const role = workspaceRole(caller, row.workspaceId);
  if (!isAuthor(caller, row) && !(role && ROLE_ACTIONS[role].includes("write")))
    throw new HttpError(403, "Only the author or an editor can resolve a thread");
  const author = authorOf(caller);
  const patch = resolved
    ? { resolvedAt: Date.now(), resolvedBy: author.name }
    : { resolvedAt: null, resolvedBy: null };
  getDb().update(comments).set(patch).where(eq(comments.id, id)).run();
  return view({ ...row, ...patch }, caller);
}

export function deleteComment(id: string): { deleted: number } {
  const caller = currentCaller();
  const row = requireComment(id);
  requireScope(caller, "write");
  const role = workspaceRole(caller, row.workspaceId);
  if (!isAuthor(caller, row) && role !== "owner")
    throw new HttpError(403, "Only the author or a workspace owner can delete a comment");
  const db = getDb();
  const ids = [row.id];
  if (!row.parentId)
    ids.push(
      ...db
        .select({ id: comments.id })
        .from(comments)
        .where(eq(comments.parentId, row.id))
        .all()
        .map((r) => r.id),
    );
  db.delete(comments).where(inArray(comments.id, ids)).run();
  return { deleted: ids.length };
}

/** Called when an element is removed so its discussion does not linger. */
export function purgeComments(kind: CommentTarget, ids: string[]) {
  if (ids.length)
    getDb()
      .delete(comments)
      .where(and(eq(comments.targetKind, kind), inArray(comments.targetId, ids)))
      .run();
}

export function listNotifications(unreadOnly = false, limit = 50) {
  const caller = currentCaller();
  const u = callerUser(caller);
  if (!u) return { notifications: [], unread: 0 };
  const db = getDb();
  const rows = db
    .select({ n: notes, c: comments })
    .from(notes)
    .innerJoin(comments, eq(comments.id, notes.commentId))
    .where(and(eq(notes.userId, u.id), unreadOnly ? isNull(notes.readAt) : undefined))
    .orderBy(desc(notes.createdAt))
    .limit(Math.min(Math.max(limit, 1), 200))
    .all()
    // Access may have been removed since: never leak a comment from a workspace they can no longer read.
    .filter((r) => workspaceRole(caller, r.c.workspaceId));
  const unread = db
    .select({ n: sql<number>`count(*)` })
    .from(notes)
    .where(and(eq(notes.userId, u.id), isNull(notes.readAt)))
    .get()!.n;
  return {
    unread,
    notifications: rows.map((r) => ({
      id: r.n.id,
      kind: r.n.kind,
      readAt: r.n.readAt,
      createdAt: r.n.createdAt,
      comment: view(r.c, caller),
    })),
  };
}

/** Mark some (or, with no ids, all) of the caller's notifications read. */
export function markNotificationsRead(ids?: string[]) {
  const u = callerUser(currentCaller());
  if (!u) return { updated: 0 };
  const where = and(
    eq(notes.userId, u.id),
    isNull(notes.readAt),
    ids?.length ? inArray(notes.id, ids) : undefined,
  );
  const res = getDb().update(notes).set({ readAt: Date.now() }).where(where).run();
  return { updated: res.changes };
}
