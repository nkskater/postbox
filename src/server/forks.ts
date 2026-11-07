/**
 * Forks and merge requests for collections.
 *
 * A fork is a copy that remembers its parent and what the parent looked like when they last agreed. The
 * same three-way merge used for installs then answers both questions: what has the parent done since
 * (sync), and what has the fork done (a merge request). A merge request is reviewed, then merged by
 * someone allowed to, and never overwrites edits made to the parent since the fork.
 */
import { and, desc, eq, or } from "drizzle-orm";
import { z } from "zod";
import {
  buildSnapshot,
  checksumOf,
  countNodes,
  diffSnapshots,
  planMerge,
  CONFLICT_STRATEGIES,
  type ConflictStrategy,
  type Snapshot,
} from "@/core/dependencies/model";
import {
  closeInput,
  mergeReadiness,
  openMergeRequestInput,
  protectedChanges,
  reviewInput,
  standingReviews,
  type MergeRequestStatus,
} from "@/core/review/model";
import { currentCaller } from "./access-context";
import { authorize, ROLE_ACTIONS, workspaceRole } from "./authorize";
import {
  applyPlan,
  materializeCollection,
  renameSids,
  settle,
  snapshotOfCopy,
  withRootName,
  type CopyRef,
} from "./collection-merge";
import { getDb, schema } from "./db";
import { newId } from "./defaults";
import { HttpError } from "./errors";
import * as repo from "./repo";
import { assertStorage } from "./usage";

const { collectionForks: forks, mergeRequests, mergeRequestReviews: reviewsTable } = schema;
type ForkRow = typeof forks.$inferSelect;
type MergeRow = typeof mergeRequests.$inferSelect;

export { openMergeRequestInput, reviewInput, closeInput };
export const forkInput = z.object({
  workspaceId: z.string().min(1),
  name: z.string().trim().min(1).max(300).optional(),
});
export const syncInput = z.object({
  strategy: z.enum(CONFLICT_STRATEGIES as [ConflictStrategy, ...ConflictStrategy[]]).default("abort"),
});

// ------------------------------------------------------------------ who

const callerUser = () => {
  const c = currentCaller();
  return c?.kind === "user" ? c.user : null;
};
const userId = () => callerUser()?.id ?? null;
function userName() {
  const u = callerUser();
  if (u) return u.displayName || u.username;
  return currentCaller()?.kind === "env" ? "Administrator" : "Anonymous";
}
const can = (workspaceId: string, action: "write" | "manage") => {
  const role = workspaceRole(currentCaller(), workspaceId);
  return !!role && ROLE_ACTIONS[role].includes(action);
};
const readable = (workspaceId: string) => workspaceRole(currentCaller(), workspaceId) !== null;

// ------------------------------------------------------------------ the two sides

const forkCopy = (fork: ForkRow): CopyRef => ({
  workspaceId: fork.workspaceId,
  kind: "collection",
  rootId: fork.folderId,
  map: fork.nodeMap,
  rootSid: fork.parentFolderId,
});

/** The parent as it is now; null when it is gone or the caller can no longer read it. */
function parentSnapshot(fork: ForkRow, keepSecrets = false): Snapshot | null {
  if (!readable(fork.parentWorkspaceId)) return null;
  const tree = repo.getFolderTree(fork.parentFolderId);
  if (!tree) return null;
  return buildSnapshot(
    tree,
    repo.listVariables(fork.parentWorkspaceId, "collection", fork.parentFolderId),
    keepSecrets,
  );
}

/** The parent addressed by its own ids, so a plan can be applied to it. */
function parentCopy(fork: ForkRow, snapshot: Snapshot): CopyRef {
  const map: Record<string, string> = {};
  const walk = (n: Snapshot["root"]) => {
    map[n.sid] = n.sid;
    n.children.forEach(walk);
  };
  walk(snapshot.root);
  return {
    workspaceId: fork.parentWorkspaceId,
    kind: "collection",
    rootId: fork.parentFolderId,
    map,
    rootSid: fork.parentFolderId,
  };
}

const rootNameOf = (s: Snapshot) => String(s.root.data.name ?? "");
const total = (d: ReturnType<typeof diffSnapshots>) =>
  d.added.length + d.removed.length + d.changed.length + d.variables.length;

// ------------------------------------------------------------------ forking

export function forkCollection(folderId: string, input: z.infer<typeof forkInput>) {
  const source = repo.getFolder(folderId);
  if (!source) throw new HttpError(404, "Collection not found");
  if (source.parentId) throw new HttpError(400, "Only a whole collection can be forked, not a folder");
  authorize(currentCaller(), source.workspaceId, "read");
  authorize(currentCaller(), input.workspaceId, "write");
  assertStorage(input.workspaceId);
  const tree = repo.getFolderTree(folderId);
  if (!tree) throw new HttpError(404, "Collection not found");
  // Credentials are never copied into a fork; the fork's owner supplies their own.
  const snapshot = buildSnapshot(tree, repo.listVariables(source.workspaceId, "collection", folderId));
  return getDb().transaction(() => {
    const made = materializeCollection(input.workspaceId, snapshot, input.name ?? `${source.name} (fork)`);
    const now = Date.now();
    const row: ForkRow = {
      id: newId(),
      workspaceId: input.workspaceId,
      folderId: made.rootId,
      parentWorkspaceId: source.workspaceId,
      parentFolderId: folderId,
      parentName: source.name,
      baseSnapshot: snapshot,
      nodeMap: made.map,
      createdBy: userId(),
      createdAt: now,
      updatedAt: now,
    };
    getDb().insert(forks).values(row).run();
    return forkView(row);
  });
}

function requireFork(id: string): ForkRow {
  const row = getDb().select().from(forks).where(eq(forks.id, id)).get();
  if (!row) throw new HttpError(404, "Fork not found");
  return row;
}

export function forkView(row: ForkRow) {
  const parent = parentSnapshot(row);
  const mine = snapshotOfCopy(forkCopy(row));
  const name = mine ? rootNameOf(mine) : row.parentName;
  const ahead = mine ? total(diffSnapshots(withRootName(row.baseSnapshot, name), mine)) : 0;
  const behind =
    parent && mine
      ? total(diffSnapshots(withRootName(row.baseSnapshot, name), withRootName(parent, name)))
      : 0;
  const open = getDb()
    .select()
    .from(mergeRequests)
    .where(and(eq(mergeRequests.forkId, row.id), eq(mergeRequests.status, "open")))
    .get();
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    folderId: row.folderId,
    parent: parent
      ? { workspaceId: row.parentWorkspaceId, folderId: row.parentFolderId, name: row.parentName }
      : null,
    parentName: row.parentName,
    status: !parent
      ? ("parent-unavailable" as const)
      : ahead && behind
        ? ("diverged" as const)
        : ahead
          ? ("ahead" as const)
          : behind
            ? ("behind" as const)
            : ("in-sync" as const),
    ahead,
    behind,
    openMergeRequestId: open?.id ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function listForks(workspaceId: string) {
  authorize(currentCaller(), workspaceId, "read");
  return getDb()
    .select()
    .from(forks)
    .where(eq(forks.workspaceId, workspaceId))
    .orderBy(desc(forks.createdAt))
    .all()
    .map(forkView);
}

/** Forks of one collection that the caller can see. */
export function listForksOf(folderId: string) {
  const folder = repo.getFolder(folderId);
  if (!folder) throw new HttpError(404, "Collection not found");
  authorize(currentCaller(), folder.workspaceId, "read");
  return getDb()
    .select()
    .from(forks)
    .where(eq(forks.parentFolderId, folderId))
    .orderBy(desc(forks.createdAt))
    .all()
    .filter((f) => readable(f.workspaceId))
    .map(forkView);
}

export function getFork(id: string) {
  return forkView(requireFork(id));
}

// ------------------------------------------------------------------ syncing from the parent

function syncState(fork: ForkRow) {
  const parent = parentSnapshot(fork);
  const mine = snapshotOfCopy(forkCopy(fork));
  if (!parent) throw new HttpError(409, "The parent collection is no longer available to you");
  if (!mine) throw new HttpError(409, "The fork's collection no longer exists");
  const name = rootNameOf(mine);
  const base = withRootName(fork.baseSnapshot, name);
  const incoming = withRootName(parent, name);
  return { parent, mine, base, incoming, plan: planMerge(base, incoming, mine) };
}

/** What pulling the parent's changes into the fork would do. */
export function previewSync(id: string) {
  const fork = requireFork(id);
  authorize(currentCaller(), fork.workspaceId, "read");
  const s = syncState(fork);
  return { diff: diffSnapshots(s.base, s.incoming), plan: s.plan };
}

export function syncFork(id: string, strategy: ConflictStrategy) {
  const fork = requireFork(id);
  authorize(currentCaller(), fork.workspaceId, "write");
  const s = syncState(fork);
  const plan = settle(s.plan, strategy, "Retry with strategy keep-local or take-incoming.");
  const own = snapshotOfCopy(forkCopy(fork), true)!;
  const applied = getDb().transaction(() => {
    const result = applyPlan(forkCopy(fork), plan, s.incoming, s.mine, withRootName(own, rootNameOf(s.mine)));
    getDb()
      .update(forks)
      .set({ baseSnapshot: s.parent, nodeMap: result.map, updatedAt: Date.now() })
      .where(eq(forks.id, id))
      .run();
    return result.counts;
  });
  return { applied, fork: forkView(requireFork(id)) };
}

/** Stop tracking a fork; its collection stays unless `deleteCopy` is set. Open requests go with it. */
export function removeFork(id: string, deleteCopy: boolean) {
  const fork = requireFork(id);
  authorize(currentCaller(), fork.workspaceId, "write");
  getDb().transaction((tx) => {
    const ids = tx
      .select({ id: mergeRequests.id })
      .from(mergeRequests)
      .where(eq(mergeRequests.forkId, id))
      .all()
      .map((m) => m.id);
    repo.discardMergeRequestComments(tx, ids);
    tx.delete(forks).where(eq(forks.id, id)).run();
  });
  if (deleteCopy) repo.deleteFolder(fork.folderId);
  return { removed: true, deletedCopy: deleteCopy };
}

// ------------------------------------------------------------------ merge requests

function requireMergeRequest(id: string): MergeRow {
  const row = getDb().select().from(mergeRequests).where(eq(mergeRequests.id, id)).get();
  if (!row) throw new HttpError(404, "Merge request not found");
  return row;
}

function openOne(forkId: string) {
  return getDb()
    .select()
    .from(mergeRequests)
    .where(and(eq(mergeRequests.forkId, forkId), eq(mergeRequests.status, "open")))
    .get();
}

/** The fork's changes against what it started from, and how they sit on the parent as it is now. */
function proposal(fork: ForkRow) {
  const parentRaw = parentSnapshot(fork);
  const headRaw = snapshotOfCopy(forkCopy(fork));
  if (!parentRaw) throw new HttpError(409, "The parent collection is no longer available");
  if (!headRaw) throw new HttpError(409, "The fork's collection no longer exists");
  const name = rootNameOf(parentRaw);
  const base = withRootName(fork.baseSnapshot, name);
  const head = withRootName(headRaw, name);
  const parent = withRootName(parentRaw, name);
  return {
    base,
    head,
    parent,
    headRaw,
    diff: diffSnapshots(base, head),
    plan: planMerge(base, head, parent),
    protectedChanges: protectedChanges(base, head),
    checksum: checksumOf(head),
  };
}

export function openMergeRequest(forkId: string, input: z.infer<typeof openMergeRequestInput>) {
  const fork = requireFork(forkId);
  authorize(currentCaller(), fork.workspaceId, "write");
  authorize(currentCaller(), fork.parentWorkspaceId, "read");
  if (openOne(forkId)) throw new HttpError(409, "This fork already has an open merge request");
  if (proposal(fork).diff.identical) throw new HttpError(409, "This fork has no changes to propose");
  const now = Date.now();
  const row: MergeRow = {
    id: newId(),
    workspaceId: fork.parentWorkspaceId,
    forkId,
    forkWorkspaceId: fork.workspaceId,
    forkFolderId: fork.folderId,
    parentFolderId: fork.parentFolderId,
    title: input.title,
    description: input.description,
    status: "open",
    createdBy: userId(),
    createdByName: userName(),
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    closedNote: null,
    mergedAt: null,
    mergedByName: null,
    mergedSummary: null,
  };
  getDb().insert(mergeRequests).values(row).run();
  return mergeRequestView(row);
}

/** Reviews of a request, each marked as standing or out of date. */
function reviewsOf(mr: MergeRow, headChecksum: string | null) {
  const all = getDb()
    .select()
    .from(reviewsTable)
    .where(eq(reviewsTable.mergeRequestId, mr.id))
    .orderBy(reviewsTable.createdAt)
    .all();
  const standing = headChecksum ? standingReviews(all, headChecksum, mr.createdBy) : null;
  return { all, standing };
}

export interface OpenDetails {
  diff: ReturnType<typeof diffSnapshots>;
  protectedChanges: ReturnType<typeof protectedChanges>;
  conflicts: { sid: string; path: string; reason?: string }[];
  variableConflicts: { key: string; reason?: string }[];
  approvals: number;
  rejections: number;
  staleReviews: number;
  readiness: ReturnType<typeof mergeReadiness>;
  can: { review: boolean; merge: boolean; close: boolean };
}

export function mergeRequestView(mr: MergeRow) {
  const fork = getDb().select().from(forks).where(eq(forks.id, mr.forkId)).get();
  const base = {
    id: mr.id,
    status: mr.status as MergeRequestStatus,
    title: mr.title,
    description: mr.description,
    workspaceId: mr.workspaceId,
    forkId: mr.forkId,
    forkWorkspaceId: mr.forkWorkspaceId,
    forkFolderId: mr.forkFolderId,
    parentFolderId: mr.parentFolderId,
    createdBy: mr.createdBy,
    createdByName: mr.createdByName,
    createdAt: mr.createdAt,
    updatedAt: mr.updatedAt,
    closedAt: mr.closedAt,
    closedNote: mr.closedNote,
    mergedAt: mr.mergedAt,
    mergedByName: mr.mergedByName,
    mergedSummary: mr.mergedSummary,
  };
  const history = getDb()
    .select()
    .from(reviewsTable)
    .where(eq(reviewsTable.mergeRequestId, mr.id))
    .orderBy(reviewsTable.createdAt)
    .all()
    .map((r) => ({ ...r, current: false }));
  if (mr.status !== "open" || !fork) return { ...base, reviews: history, open: null as null };

  let p: ReturnType<typeof proposal>;
  try {
    p = proposal(fork);
  } catch (e) {
    return {
      ...base,
      reviews: history,
      open: { unavailable: (e as Error).message } as { unavailable: string },
    };
  }
  const { all, standing } = reviewsOf(mr, p.checksum);
  const owner = can(mr.workspaceId, "manage");
  const readiness = mergeReadiness({
    conflicts: p.plan.conflicts,
    approvals: standing!.approvals.length,
    rejections: standing!.rejections.length,
    protectedCount: p.protectedChanges.length,
    mergerIsOwner: owner,
    hasChanges: !p.diff.identical,
  });
  const currentIds = new Set([...standing!.approvals, ...standing!.rejections].map((r) => r.id));
  return {
    ...base,
    reviews: all.map((r) => ({ ...r, current: currentIds.has(r.id) })),
    open: <OpenDetails>{
      diff: p.diff,
      protectedChanges: p.protectedChanges,
      conflicts: p.plan.entries.filter((e) => e.action === "conflict"),
      variableConflicts: p.plan.variables.filter((v) => v.action === "conflict"),
      approvals: standing!.approvals.length,
      rejections: standing!.rejections.length,
      staleReviews: standing!.stale.length,
      readiness,
      can: {
        review: can(mr.workspaceId, "write") && !(mr.createdBy !== null && mr.createdBy === userId()),
        merge: can(mr.workspaceId, "write") && readiness.ok,
        close: can(mr.workspaceId, "manage") || isAuthor(mr),
      },
    },
  };
}

const isAuthor = (mr: MergeRow) => (mr.createdBy === null ? !callerUser() : mr.createdBy === userId());

export function getMergeRequest(id: string) {
  const mr = requireMergeRequest(id);
  authorize(currentCaller(), mr.workspaceId, "read");
  return mergeRequestView(mr);
}

/** Requests where the workspace is the parent (to review) or the fork's home (that it proposed). */
export function listMergeRequests(workspaceId: string, status?: string) {
  authorize(currentCaller(), workspaceId, "read");
  return getDb()
    .select()
    .from(mergeRequests)
    .where(or(eq(mergeRequests.workspaceId, workspaceId), eq(mergeRequests.forkWorkspaceId, workspaceId)))
    .orderBy(desc(mergeRequests.createdAt))
    .all()
    .filter((m) => !status || m.status === status)
    .map((m) => ({
      id: m.id,
      title: m.title,
      status: m.status,
      workspaceId: m.workspaceId,
      forkWorkspaceId: m.forkWorkspaceId,
      forkFolderId: m.forkFolderId,
      parentFolderId: m.parentFolderId,
      createdByName: m.createdByName,
      createdAt: m.createdAt,
      role: m.workspaceId === workspaceId ? ("parent" as const) : ("fork" as const),
    }));
}

export function reviewMergeRequest(id: string, input: z.infer<typeof reviewInput>) {
  const mr = requireMergeRequest(id);
  authorize(currentCaller(), mr.workspaceId, "write");
  if (mr.status !== "open") throw new HttpError(409, `This request is already ${mr.status}`);
  if (input.decision === "approve" && mr.createdBy !== null && mr.createdBy === userId())
    throw new HttpError(403, "You cannot approve your own merge request");
  const fork = requireFork(mr.forkId);
  const p = proposal(fork);
  getDb()
    .insert(reviewsTable)
    .values({
      id: newId(),
      mergeRequestId: id,
      reviewerId: userId(),
      reviewerName: userName(),
      decision: input.decision,
      note: input.note,
      headChecksum: p.checksum,
      createdAt: Date.now(),
    })
    .run();
  getDb().update(mergeRequests).set({ updatedAt: Date.now() }).where(eq(mergeRequests.id, id)).run();
  return mergeRequestView(requireMergeRequest(id));
}

export function closeMergeRequest(id: string, note: string) {
  const mr = requireMergeRequest(id);
  authorize(currentCaller(), mr.workspaceId, "read");
  if (mr.status !== "open") throw new HttpError(409, `This request is already ${mr.status}`);
  if (!(isAuthor(mr) || can(mr.workspaceId, "manage")))
    throw new HttpError(403, "Only its author or a workspace owner can close a merge request");
  const now = Date.now();
  getDb()
    .update(mergeRequests)
    .set({ status: "closed", closedAt: now, closedNote: note || null, updatedAt: now })
    .where(eq(mergeRequests.id, id))
    .run();
  return mergeRequestView(requireMergeRequest(id));
}

export function mergeMergeRequest(id: string) {
  const mr = requireMergeRequest(id);
  authorize(currentCaller(), mr.workspaceId, "write");
  if (mr.status !== "open") throw new HttpError(409, `This request is already ${mr.status}`);
  const fork = requireFork(mr.forkId);
  const p = proposal(fork);
  const { standing } = reviewsOf(mr, p.checksum);
  const owner = can(mr.workspaceId, "manage");
  const readiness = mergeReadiness({
    conflicts: p.plan.conflicts,
    approvals: standing!.approvals.length,
    rejections: standing!.rejections.length,
    protectedCount: p.protectedChanges.length,
    mergerIsOwner: owner,
    hasChanges: !p.diff.identical,
  });
  if (!readiness.ok)
    throw new HttpError(p.protectedChanges.length && !owner ? 403 : 409, readiness.reasons.join("; "));

  const parentRaw = parentSnapshot(fork, true)!;
  const ownParent = withRootName(parentRaw, rootNameOf(parentRaw));
  const copy = parentCopy(fork, p.parent);
  const merged = getDb().transaction(() => {
    const result = applyPlan(copy, p.plan, p.head, p.parent, ownParent);
    // New requests got ids in the parent; the fork's content now equals what it proposed, so that is the
    // new common ground and later changes on either side compare against it.
    const created: Record<string, string> = {};
    for (const [sid, newId] of Object.entries(result.map)) if (sid.startsWith("local:")) created[sid] = newId;
    const base = renameSids(p.headRaw, created);
    const nodeMap: Record<string, string> = {};
    const known = new Set<string>();
    const mark = (n: Snapshot["root"]) => {
      known.add(n.sid);
      n.children.forEach(mark);
    };
    mark(base.root);
    for (const [parentId, forkId] of Object.entries(fork.nodeMap))
      if (known.has(parentId)) nodeMap[parentId] = forkId;
    for (const [sid, parentId] of Object.entries(created)) nodeMap[parentId] = sid.slice("local:".length);
    const now = Date.now();
    getDb()
      .update(forks)
      .set({ baseSnapshot: base, nodeMap, updatedAt: now })
      .where(eq(forks.id, fork.id))
      .run();
    const summary = { ...result.counts, variables: p.diff.variables.length, ...countNodes(p.head) };
    getDb()
      .update(mergeRequests)
      .set({
        status: "merged",
        mergedAt: now,
        mergedByName: userName(),
        mergedSummary: summary,
        updatedAt: now,
      })
      .where(eq(mergeRequests.id, id))
      .run();
    return result.counts;
  });
  return { applied: merged, mergeRequest: mergeRequestView(requireMergeRequest(id)) };
}
