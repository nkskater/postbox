/**
 * Forks and merge requests for API specifications.
 *
 * Same idea as collections (see forks.ts), but a specification is a set of source files and an entrypoint,
 * so the three-way merge works file by file (src/core/review/files.ts). A merge becomes the next revision of
 * the original; nothing is overwritten that changed there since the fork.
 *
 * forks.ts owns the shared table rows, reviews and permissions; this file supplies what differs by kind.
 */
import { and, eq } from "drizzle-orm";
import { checksumOf } from "@/core/dependencies/model";
import { governanceVerdict } from "@/core/review/governance";
import {
  diffFiles,
  mergeFiles,
  planFileMerge,
  type FileDiff,
  type FileState,
  type FileStrategy,
} from "@/core/review/files";
import { currentCaller } from "./access-context";
import { authorize, workspaceRole } from "./authorize";
import { getDb, schema } from "./db";
import { newId } from "./defaults";
import { lintForMerge } from "./governance";
import { HttpError } from "./errors";
import {
  createSpecification,
  getSpecification,
  requireSpecification,
  saveSpecification,
} from "./specifications";

const { collectionForks: forks, mergeRequests } = schema;
export type SpecForkRow = typeof forks.$inferSelect;

/** Placeholder for the (unused) collection snapshot column of a specification fork. */
const NO_SNAPSHOT: SpecForkRow["baseSnapshot"] = {
  schema: 1,
  name: "",
  root: { sid: "", kind: "folder", data: {}, children: [] },
  variables: [],
};

const readable = (workspaceId: string) => workspaceRole(currentCaller(), workspaceId) !== null;
const userId = () => {
  const c = currentCaller();
  return c?.kind === "user" ? c.user.id : null;
};

/**
 * The current revision of a specification, read without a workspace check. A merge request is reviewed by the
 * original's members, who need to see the fork's content even though they cannot open the fork's workspace;
 * access to the request itself is what authorizes this.
 */
function readSpec(id: string) {
  const row = getDb().select().from(schema.specifications).where(eq(schema.specifications.id, id)).get();
  if (!row) return null;
  const version = getDb()
    .select()
    .from(schema.specificationVersions)
    .where(
      and(
        eq(schema.specificationVersions.specificationId, id),
        eq(schema.specificationVersions.version, row.revision),
      ),
    )
    .get();
  if (!version) return null;
  return {
    name: row.name,
    format: row.format,
    revision: row.revision,
    entrypoint: version.entrypoint,
    files: version.files,
  };
}

const stateOf = (spec: { entrypoint: string; files: { path: string; content: string }[] }): FileState => ({
  entrypoint: spec.entrypoint,
  files: spec.files.map((f) => ({ path: f.path, content: f.content })),
});

/** The parent as it is now; null when it is gone or the caller can no longer read it. */
function parentOf(fork: SpecForkRow): { state: FileState; revision: number; format: string } | null {
  if (!readable(fork.parentWorkspaceId)) return null;
  const p = readSpec(fork.parentFolderId);
  return p ? { state: stateOf(p), revision: p.revision, format: p.format } : null;
}
function forkSpecOf(fork: SpecForkRow): { state: FileState; revision: number; name: string } | null {
  const s = readSpec(fork.folderId);
  return s ? { state: stateOf(s), revision: s.revision, name: s.name } : null;
}
const baseOf = (fork: SpecForkRow): FileState => fork.baseFiles ?? { entrypoint: "", files: [] };

/** The diff in the same shape the collection views use, so the one UI renders both. */
function uiDiff(d: FileDiff) {
  const node = (path: string) => ({ sid: path, kind: "request" as const, path });
  return {
    added: d.added.map(node),
    removed: d.removed.map(node),
    changed: [
      ...d.changed.map((p) => ({ ...node(p), fields: ["content"] })),
      ...(d.entrypoint ? [{ ...node("the entrypoint"), fields: ["entrypoint"] }] : []),
    ],
    variables: [] as { key: string; change: "added" | "removed" | "changed" }[],
    identical: d.identical,
  };
}
const size = (d: FileDiff) => d.added.length + d.removed.length + d.changed.length + (d.entrypoint ? 1 : 0);

// ------------------------------------------------------------------ forking

export function forkSpecification(specId: string, input: { workspaceId: string; name?: string }) {
  const source = requireSpecification(specId);
  authorize(currentCaller(), input.workspaceId, "write");
  const cur = getSpecification(specId);
  const created = createSpecification({
    workspaceId: input.workspaceId,
    name: input.name ?? `${cur.name} (fork)`,
    label: `Forked from ${cur.name}`,
    format: cur.format,
    entrypoint: cur.entrypoint,
    files: stateOf(cur).files,
  });
  const now = Date.now();
  const row: SpecForkRow = {
    id: newId(),
    kind: "specification",
    workspaceId: input.workspaceId,
    folderId: created.id,
    parentWorkspaceId: source.workspaceId,
    parentFolderId: specId,
    parentName: cur.name,
    baseSnapshot: NO_SNAPSHOT,
    baseFiles: stateOf(cur),
    nodeMap: {},
    createdBy: userId(),
    createdAt: now,
    updatedAt: now,
  };
  getDb().insert(forks).values(row).run();
  return specForkView(row);
}

export function specForkView(row: SpecForkRow) {
  const parent = parentOf(row);
  const mine = forkSpecOf(row);
  const base = baseOf(row);
  const ahead = mine ? size(diffFiles(base, mine.state)) : 0;
  const behind = parent && mine ? size(diffFiles(base, parent.state)) : 0;
  const open = getDb()
    .select()
    .from(mergeRequests)
    .where(and(eq(mergeRequests.forkId, row.id), eq(mergeRequests.status, "open")))
    .get();
  return {
    id: row.id,
    kind: "specification" as const,
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

/** Forks of one specification that the caller can see. */
export function listSpecForksOf(specId: string) {
  const spec = requireSpecification(specId);
  authorize(currentCaller(), spec.workspaceId, "read");
  return getDb()
    .select()
    .from(forks)
    .where(and(eq(forks.parentFolderId, specId), eq(forks.kind, "specification")))
    .all()
    .filter((f) => readable(f.workspaceId))
    .map(specForkView);
}

// ------------------------------------------------------------------ syncing

function syncState(fork: SpecForkRow) {
  const parent = parentOf(fork);
  const mine = forkSpecOf(fork);
  if (!parent) throw new HttpError(409, "The parent specification is no longer available to you");
  if (!mine) throw new HttpError(409, "The fork's specification no longer exists");
  const base = baseOf(fork);
  return { parent, mine, base, plan: planFileMerge(base, parent.state, mine.state) };
}

export function previewSpecSync(fork: SpecForkRow) {
  const s = syncState(fork);
  return {
    diff: uiDiff(diffFiles(s.base, s.parent.state)),
    plan: {
      conflicts: s.plan.conflicts,
      entries: s.plan.entries.map((e) => ({ sid: e.path, kind: "request" as const, ...e })),
      variables: [] as { key: string; action: string }[],
    },
  };
}

export function syncSpecFork(fork: SpecForkRow, strategy: FileStrategy) {
  authorize(currentCaller(), fork.workspaceId, "write");
  const s = syncState(fork);
  if (s.plan.conflicts && strategy === "abort")
    throw new HttpError(
      409,
      `${s.plan.conflicts} conflict(s): ${s.plan.entries
        .filter((e) => e.action === "conflict")
        .map((e) => `${e.path} (${e.reason})`)
        .join("; ")}. Retry with strategy keep-local or take-incoming.`,
    );
  const merged = mergeFiles(
    s.base,
    s.parent.state,
    s.mine.state,
    strategy === "abort" ? "keep-local" : strategy,
  );
  const diff = diffFiles(s.mine.state, merged);
  if (!diff.identical) {
    if (!merged.files.some((f) => f.path === merged.entrypoint))
      throw new HttpError(
        409,
        "The merged specification has no file for its entrypoint; resolve the entrypoint first",
      );
    saveSpecification(fork.folderId, {
      expectedRevision: s.mine.revision,
      entrypoint: merged.entrypoint,
      files: merged.files,
      label: `Synced with ${fork.parentName}`,
    });
  }
  getDb()
    .update(forks)
    .set({ baseFiles: s.parent.state, updatedAt: Date.now() })
    .where(eq(forks.id, fork.id))
    .run();
  return {
    applied: {
      added: diff.added.length,
      updated: diff.changed.length + (diff.entrypoint ? 1 : 0),
      removed: diff.removed.length,
    },
  };
}

// ------------------------------------------------------------------ merge requests

/**
 * What the parent's governance rule set says about the result of the merge, counting only findings the merge
 * would add. Null when no rule set is bound or the merge cannot be computed yet (conflicts).
 */
function governanceOf(
  fork: SpecForkRow,
  parent: { state: FileState; format: string },
  head: FileState,
  base: FileState,
  conflicts: number,
) {
  if (conflicts) return null;
  try {
    const merged = mergeFiles(base, head, parent.state, "keep-local");
    const source = (state: FileState) => ({
      format: parent.format as "openapi",
      entrypoint: state.entrypoint,
      files: state.files,
    });
    const linted = lintForMerge(fork.parentFolderId, source(parent.state), source(merged));
    if (!linted) return null;
    const verdict = governanceVerdict(linted.before, linted.after);
    return { ruleSet: linted.ruleSet, ...verdict, unavailable: null as string | null };
  } catch (error) {
    return {
      ruleSet: null,
      newErrors: [],
      newWarnings: [],
      newInfo: 0,
      fixed: 0,
      unavailable: (error as Error).message,
    };
  }
}

/** The fork's changes against what it started from, and how they sit on the parent as it is now. */
export function specProposal(fork: SpecForkRow) {
  const parent = parentOf(fork);
  const mine = forkSpecOf(fork);
  if (!parent) throw new HttpError(409, "The parent specification is no longer available");
  if (!mine) throw new HttpError(409, "The fork's specification no longer exists");
  const base = baseOf(fork);
  const diff = diffFiles(base, mine.state);
  const plan = planFileMerge(base, mine.state, parent.state);
  return {
    governance: governanceOf(fork, parent, mine.state, base, plan.conflicts),
    base,
    head: mine.state,
    parent,
    diff: uiDiff(diff),
    identical: diff.identical,
    plan,
    conflicts: plan.entries
      .filter((e) => e.action === "conflict")
      .map((e) => ({ sid: e.path, path: e.path, reason: e.reason })),
    checksum: checksumOf(mine.state),
  };
}

/** Apply a proposal to the parent as its next revision. Call only once it is allowed. */
export function mergeSpecProposal(fork: SpecForkRow, title: string, p: ReturnType<typeof specProposal>) {
  const merged = mergeFiles(p.base, p.head, p.parent.state, "keep-local");
  if (!merged.files.some((f) => f.path === merged.entrypoint))
    throw new HttpError(409, "The merged specification has no file for its entrypoint");
  const diff = diffFiles(p.parent.state, merged);
  if (!diff.identical)
    saveSpecification(fork.parentFolderId, {
      expectedRevision: p.parent.revision,
      entrypoint: merged.entrypoint,
      files: merged.files,
      label: `Merged: ${title}`.slice(0, 200),
    });
  // What the fork proposed is now part of the parent, so it is the new common ground.
  getDb().update(forks).set({ baseFiles: p.head, updatedAt: Date.now() }).where(eq(forks.id, fork.id)).run();
  return {
    added: diff.added.length,
    updated: diff.changed.length + (diff.entrypoint ? 1 : 0),
    removed: diff.removed.length,
  };
}
