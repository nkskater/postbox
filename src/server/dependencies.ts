/**
 * Shared collection dependencies: publish a collection as an immutable, secret-free release, install a
 * release into another workspace pinned to its version and checksum, and update that copy later without
 * losing the edits and credentials made locally.
 *
 * The comparison and merge rules live in src/core/dependencies/model.ts; this file supplies the data,
 * checks who may do what, and applies a plan to the database.
 */
import { and, desc, eq, max } from "drizzle-orm";
import { z } from "zod";
import {
  RELEASE_LIMITS,
  RELEASE_VISIBILITIES,
  CONFLICT_STRATEGIES,
  buildEnvironmentSnapshot,
  buildSnapshot,
  checksumOf,
  countNodes,
  diffSnapshots,
  flatten,
  planMerge,
  resolveConflicts,
  restoreLocalSecrets,
  type ConflictStrategy,
  type DependencyKind,
  type MergePlan,
  type SnapNode,
  type Snapshot,
} from "@/core/dependencies/model";
import type { FolderDef, FolderNode, RequestDef, TreeNode, Variable } from "@/core/types";
import { currentCaller } from "./access-context";
import { authorize, workspaceRole } from "./authorize";
import { getDb, schema } from "./db";
import { newId } from "./defaults";
import { HttpError } from "./errors";
import * as repo from "./repo";
import { assertStorage } from "./usage";

const { dependencyReleases: releases, dependencyInstalls: installs } = schema;
type ReleaseRow = typeof releases.$inferSelect;
type InstallRow = typeof installs.$inferSelect;

export const publishInput = z.object({
  version: z.string().regex(RELEASE_LIMITS.versionPattern, "Use letters, digits and . _ + - (up to 64)"),
  notes: z.string().max(RELEASE_LIMITS.notes).default(""),
  visibility: z.enum(RELEASE_VISIBILITIES).default("workspace"),
});
export const installInput = z.object({ workspaceId: z.string().min(1), releaseId: z.string().min(1) });
export const updateInput = z.object({
  releaseId: z.string().min(1).optional(),
  strategy: z.enum(CONFLICT_STRATEGIES as [ConflictStrategy, ...ConflictStrategy[]]).default("abort"),
});
export const revokeInput = z.object({ reason: z.string().trim().min(1).max(500) });

const userId = () => {
  const c = currentCaller();
  return c?.kind === "user" ? c.user.id : null;
};

// ------------------------------------------------------------------ releases

/** A release without its (large) snapshot. */
export function releaseView(row: ReleaseRow) {
  const { snapshot: _snapshot, ...rest } = row;
  return rest;
}

/** Whether the signed-in caller may look at, and install, this release. */
function canSee(row: ReleaseRow): boolean {
  return row.visibility === "instance" || workspaceRole(currentCaller(), row.workspaceId) !== null;
}
function visibleRelease(id: string): ReleaseRow {
  const row = getDb().select().from(releases).where(eq(releases.id, id)).get();
  // A release the caller may not see is reported as missing, so its existence is not disclosed.
  if (!row || !canSee(row)) throw new HttpError(404, "Release not found");
  return row;
}

type PublishInput = z.infer<typeof publishInput>;

/** Store a release of `sourceId`, enforcing the same rules whatever the kind. */
function insertRelease(
  kind: DependencyKind,
  workspaceId: string,
  sourceId: string,
  name: string,
  snapshot: Snapshot,
  input: PublishInput,
) {
  // Anyone on the instance can install an instance-wide release, so that takes the manage role.
  authorize(currentCaller(), workspaceId, input.visibility === "instance" ? "manage" : "write");
  assertStorage(workspaceId);
  if (Buffer.byteLength(JSON.stringify(snapshot)) > RELEASE_LIMITS.snapshotBytes)
    throw new HttpError(413, "This is too large to publish");
  const checksum = checksumOf(snapshot);
  return getDb().transaction((tx) => {
    const existing = tx
      .select()
      .from(releases)
      .where(eq(releases.folderId, sourceId))
      .orderBy(desc(releases.seq))
      .all();
    if (existing.some((r) => r.version === input.version))
      throw new HttpError(409, `Version ${input.version} is already published; versions cannot be changed`);
    const latest = existing.find((r) => !r.revokedAt);
    if (latest && latest.checksum === checksum)
      throw new HttpError(409, `Nothing has changed since ${latest.version}`);
    const counts = countNodes(snapshot);
    const row: ReleaseRow = {
      id: newId(),
      workspaceId,
      kind,
      folderId: sourceId,
      name,
      version: input.version,
      seq: (existing[0]?.seq ?? 0) + 1,
      notes: input.notes,
      visibility: input.visibility,
      checksum,
      snapshot,
      folderCount: counts.folders,
      requestCount: counts.requests,
      revokedAt: null,
      revokedReason: null,
      revokedBy: null,
      createdBy: userId(),
      createdAt: Date.now(),
    };
    tx.insert(releases).values(row).run();
    return releaseView(row);
  });
}

export function publishRelease(folderId: string, input: PublishInput) {
  const folder = repo.getFolder(folderId);
  if (!folder) throw new HttpError(404, "Collection not found");
  if (folder.parentId) throw new HttpError(400, "Only a whole collection can be published, not a folder");
  const tree = repo.getFolderTree(folderId);
  if (!tree) throw new HttpError(404, "Collection not found");
  const snapshot = buildSnapshot(tree, repo.listVariables(folder.workspaceId, "collection", folderId));
  return insertRelease("collection", folder.workspaceId, folderId, folder.name, snapshot, input);
}

export function publishEnvironmentRelease(environmentId: string, input: PublishInput) {
  const env = repo.getEnvironment(environmentId);
  if (!env) throw new HttpError(404, "Environment not found");
  return insertRelease(
    "environment",
    env.workspaceId,
    environmentId,
    env.name,
    buildEnvironmentSnapshot(env, env.variables),
    input,
  );
}

/** Every release of one collection or environment, newest first. */
export function listReleases(folderId: string, kind: DependencyKind = "collection") {
  const workspaceId =
    kind === "environment"
      ? repo.getEnvironment(folderId)?.workspaceId
      : repo.getFolder(folderId)?.workspaceId;
  if (!workspaceId)
    throw new HttpError(404, kind === "environment" ? "Environment not found" : "Collection not found");
  authorize(currentCaller(), workspaceId, "read");
  return getDb()
    .select()
    .from(releases)
    .where(eq(releases.folderId, folderId))
    .orderBy(desc(releases.seq))
    .all()
    .map(releaseView);
}

/** Releases the caller could install into `workspaceId`: shared with them, from other workspaces. */
export function browseReleases(workspaceId: string) {
  authorize(currentCaller(), workspaceId, "read");
  return getDb()
    .select()
    .from(releases)
    .orderBy(desc(releases.createdAt))
    .all()
    .filter((r) => r.workspaceId !== workspaceId && canSee(r))
    .slice(0, 500)
    .map(releaseView);
}

export function getRelease(id: string) {
  return releaseView(visibleRelease(id));
}

export function revokeRelease(id: string, reason: string) {
  const row = getDb().select().from(releases).where(eq(releases.id, id)).get();
  if (!row) throw new HttpError(404, "Release not found");
  authorize(currentCaller(), row.workspaceId, "manage");
  if (row.revokedAt) return releaseView(row);
  const patch = { revokedAt: Date.now(), revokedReason: reason, revokedBy: userId() };
  getDb().update(releases).set(patch).where(eq(releases.id, id)).run();
  return releaseView({ ...row, ...patch });
}

// ------------------------------------------------------------------ installing

function rootAndBase(row: ReleaseRow) {
  return { snapshot: row.snapshot, root: row.snapshot.root };
}

/** Create the folders and requests of `node` under `parent`, recording where each source node went. */
function materialize(
  workspaceId: string,
  node: SnapNode,
  parent: string | null,
  map: Record<string, string>,
) {
  if (node.kind === "folder") {
    const folder = repo.createFolder(workspaceId, parent, node.data as Partial<FolderDef>);
    map[node.sid] = folder.id;
    for (const child of node.children) materialize(workspaceId, child, folder.id, map);
  } else {
    map[node.sid] = repo.createRequest(workspaceId, parent!, node.data as Partial<RequestDef>).id;
  }
}

export function installRelease(input: z.infer<typeof installInput>) {
  const caller = currentCaller();
  authorize(caller, input.workspaceId, "write");
  const release = visibleRelease(input.releaseId);
  if (release.revokedAt) throw new HttpError(409, `This version was withdrawn: ${release.revokedReason}`);
  if (release.workspaceId === input.workspaceId)
    throw new HttpError(409, "This collection already lives in this workspace; install it into another one");
  assertStorage(input.workspaceId);
  const { snapshot, root } = rootAndBase(release);
  const map: Record<string, string> = {};
  return getDb().transaction(() => {
    let folderId: string;
    if (release.kind === "environment") {
      folderId = repo.createEnvironment(input.workspaceId, snapshot.name, snapshot.variables).id;
    } else {
      materialize(input.workspaceId, root, null, map);
      folderId = map[root.sid];
      if (snapshot.variables.length)
        repo.replaceVariables(input.workspaceId, "collection", folderId, snapshot.variables);
    }
    const now = Date.now();
    const row: InstallRow = {
      id: newId(),
      workspaceId: input.workspaceId,
      kind: release.kind,
      folderId,
      releaseId: release.id,
      sourceWorkspaceId: release.workspaceId,
      sourceFolderId: release.folderId,
      sourceName: release.name,
      version: release.version,
      checksum: release.checksum,
      baseSnapshot: snapshot,
      nodeMap: map,
      installedBy: userId(),
      installedAt: now,
      updatedAt: now,
    };
    getDb().insert(installs).values(row).run();
    return installView(row);
  });
}

// ------------------------------------------------------------------ the local copy

const reverse = (map: Record<string, string>) =>
  Object.fromEntries(Object.entries(map).map(([sid, id]) => [id, sid]));

/** The local copy as a snapshot whose node ids are the source's, so it can be compared with a release. */
function localSnapshot(row: InstallRow, keepSecrets = false): Snapshot | null {
  if (row.kind === "environment") {
    const env = repo.getEnvironment(row.folderId);
    if (!env) return null;
    return buildEnvironmentSnapshot(
      { id: row.baseSnapshot.root.sid, name: env.name },
      env.variables,
      keepSecrets,
    );
  }
  const tree = repo.getFolderTree(row.folderId);
  if (!tree) return null;
  const back = reverse(row.nodeMap);
  const rename = (node: TreeNode): TreeNode =>
    node.kind === "folder"
      ? ({
          ...node,
          id: back[node.id] ?? `local:${node.id}`,
          children: node.children.map(rename),
        } as FolderNode)
      : { ...node, id: back[node.id] ?? `local:${node.id}` };
  return buildSnapshot(
    rename(tree) as FolderNode,
    repo.listVariables(row.workspaceId, "collection", row.folderId),
    keepSecrets,
  );
}

function sourceReleases(row: InstallRow): ReleaseRow[] {
  return getDb()
    .select()
    .from(releases)
    .where(eq(releases.folderId, row.sourceFolderId))
    .orderBy(desc(releases.seq))
    .all()
    .filter(canSee);
}

export type InstallStatus = "current" | "update-available" | "withdrawn" | "source-unavailable";

export function installView(row: InstallRow) {
  const available = sourceReleases(row);
  const installed = available.find((r) => r.id === row.releaseId);
  const latest = available.find((r) => !r.revokedAt);
  let status: InstallStatus;
  if (!installed) status = "source-unavailable";
  else if (installed.revokedAt) status = "withdrawn";
  else if (latest && latest.seq > installed.seq) status = "update-available";
  else status = "current";
  const local = localSnapshot(row);
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    kind: row.kind,
    folderId: row.folderId,
    sourceWorkspaceId: row.sourceWorkspaceId,
    sourceFolderId: row.sourceFolderId,
    name: row.sourceName,
    version: row.version,
    checksum: row.checksum,
    releaseId: row.releaseId,
    status,
    withdrawnReason: installed?.revokedReason ?? null,
    latestVersion: latest?.version ?? null,
    latestReleaseId: latest?.id ?? null,
    modified: local ? !diffSnapshots(row.baseSnapshot, local).identical : false,
    installedAt: row.installedAt,
    updatedAt: row.updatedAt,
  };
}

function requireInstall(id: string): InstallRow {
  const row = getDb().select().from(installs).where(eq(installs.id, id)).get();
  if (!row) throw new HttpError(404, "Dependency not found");
  return row;
}

export function listInstalls(workspaceId: string) {
  authorize(currentCaller(), workspaceId, "read");
  return getDb()
    .select()
    .from(installs)
    .where(eq(installs.workspaceId, workspaceId))
    .orderBy(desc(installs.installedAt))
    .all()
    .map(installView);
}

export function getInstall(id: string) {
  return installView(requireInstall(id));
}

function targetRelease(row: InstallRow, releaseId?: string): ReleaseRow {
  const target = releaseId ? visibleRelease(releaseId) : sourceReleases(row).find((r) => !r.revokedAt);
  if (!target) throw new HttpError(404, "The source of this collection is no longer available to you");
  if (target.folderId !== row.sourceFolderId || target.kind !== row.kind)
    throw new HttpError(400, "That release belongs to something else");
  return target;
}

/** What an update to `releaseId` (default: the newest) would change, and where it would collide with local edits. */
export function previewUpdate(id: string, releaseId?: string) {
  const row = requireInstall(id);
  authorize(currentCaller(), row.workspaceId, "read");
  const target = targetRelease(row, releaseId);
  const local = localSnapshot(row);
  if (!local) throw new HttpError(409, "The local copy no longer exists");
  return {
    from: row.version,
    to: target.version,
    withdrawn: !!target.revokedAt,
    diff: diffSnapshots(row.baseSnapshot, target.snapshot),
    localChanges: diffSnapshots(row.baseSnapshot, local),
    plan: planMerge(row.baseSnapshot, target.snapshot, local),
  };
}

const depth = (nodes: ReturnType<typeof flatten>, sid: string) => {
  let d = 0;
  for (let c = nodes.get(sid)?.parent; c; c = nodes.get(c)?.parent) d++;
  return d;
};

export function updateInstall(id: string, input: z.infer<typeof updateInput>) {
  const row = requireInstall(id);
  authorize(currentCaller(), row.workspaceId, "write");
  const target = targetRelease(row, input.releaseId);
  if (target.revokedAt) throw new HttpError(409, `This version was withdrawn: ${target.revokedReason}`);
  if (target.id === row.releaseId) throw new HttpError(409, `Already on ${target.version}`);
  const local = localSnapshot(row);
  if (!local) throw new HttpError(409, "The local copy no longer exists");
  let plan: MergePlan = planMerge(row.baseSnapshot, target.snapshot, local);
  if (plan.conflicts) {
    if (input.strategy === "abort") {
      const where = [
        ...plan.entries.filter((e) => e.action === "conflict").map((e) => `${e.path} (${e.reason})`),
        ...plan.variables
          .filter((v) => v.action === "conflict")
          .map((v) => `variable ${v.key} (${v.reason})`),
      ];
      throw new HttpError(
        409,
        `${plan.conflicts} conflict(s) with your edits: ${where.slice(0, 5).join("; ")}. Retry with strategy keep-local or take-incoming.`,
      );
    }
    plan = resolveConflicts(plan, input.strategy);
  }

  const incoming = flatten(target.snapshot);
  const current = flatten(local);
  // The user's own credentials, which a comparison snapshot leaves out but an update must not lose.
  const own = flatten(localSnapshot(row, true)!);
  const map = { ...row.nodeMap };
  const rootLocal = row.folderId;
  const parentLocal = (sid: string | null) => (sid ? (map[sid] ?? rootLocal) : rootLocal);
  const counts = { added: 0, updated: 0, removed: 0 };

  getDb().transaction(() => {
    const action = new Map(plan.entries.map((e) => [e.sid, e.action]));
    // Parents before children, so a new folder exists before the nodes that go inside it.
    const isCollection = row.kind === "collection";
    if (!isCollection) {
      // An environment has no tree, only a name and its variables.
      const rootEntry = plan.entries.find((e) => e.sid === target.snapshot.root.sid);
      if (rootEntry?.action === "update") {
        repo.renameEnvironment(rootLocal, String(target.snapshot.root.data.name ?? ""));
        counts.updated++;
      }
    }
    const ordered = isCollection
      ? [...incoming.values()].sort((a, b) => depth(incoming, a.sid) - depth(incoming, b.sid))
      : [];
    for (const node of ordered) {
      const act = action.get(node.sid);
      if (act === "add") {
        const parent = parentLocal(node.parent);
        const data = node.data;
        map[node.sid] =
          node.kind === "folder"
            ? repo.createFolder(row.workspaceId, parent, data as Partial<FolderDef>).id
            : repo.createRequest(row.workspaceId, parent, data as Partial<RequestDef>).id;
        counts.added++;
      } else if (act === "update" && map[node.sid]) {
        const merged = restoreLocalSecrets(node.data, own.get(node.sid)?.data) as Record<string, unknown>;
        if (node.kind === "folder") repo.updateFolder(map[node.sid], merged as Partial<FolderDef>);
        else repo.updateRequest(map[node.sid], merged as Partial<RequestDef>);
        const before = current.get(node.sid);
        if (before && before.parent !== node.parent && node.parent)
          repo.reorder(node.kind, map[node.sid], parentLocal(node.parent), Number.MAX_SAFE_INTEGER);
        counts.updated++;
      }
    }
    // Deepest first, so a folder is removed after what was inside it.
    const gone = (isCollection ? plan.entries : [])
      .filter((e) => e.action === "remove" && map[e.sid])
      .sort((a, b) => depth(current, b.sid) - depth(current, a.sid));
    for (const e of gone) {
      if (!repo.getFolder(map[e.sid]) && e.kind === "folder") {
        delete map[e.sid];
        continue;
      }
      if (e.kind === "folder") repo.deleteFolder(map[e.sid]);
      else repo.deleteRequest(map[e.sid]);
      delete map[e.sid];
      counts.removed++;
    }

    // Variables: apply the plan key by key, never overwriting a secret the user filled in.
    const scope = isCollection ? "collection" : "environment";
    const have = new Map(repo.listVariables(row.workspaceId, scope, rootLocal).map((v) => [v.key, v]));
    const wanted = new Map(target.snapshot.variables.map((v) => [v.key, v]));
    for (const v of plan.variables) {
      if (v.action === "remove") have.delete(v.key);
      else if (v.action === "add" || v.action === "update") {
        const next = wanted.get(v.key);
        if (!next) have.delete(v.key);
        else have.set(v.key, restoreLocalSecrets(next, have.get(v.key)) as Variable);
      }
    }
    repo.replaceVariables(row.workspaceId, scope, rootLocal, [...have.values()]);

    getDb()
      .update(installs)
      .set({
        releaseId: target.id,
        version: target.version,
        checksum: target.checksum,
        baseSnapshot: target.snapshot,
        nodeMap: map,
        updatedAt: Date.now(),
      })
      .where(eq(installs.id, id))
      .run();
  });
  return { applied: counts, dependency: installView(requireInstall(id)) };
}

/** Stop tracking a dependency. The local collection or environment stays unless `deleteCopy` is set. */
export function removeInstall(id: string, deleteCopy: boolean) {
  const row = requireInstall(id);
  authorize(currentCaller(), row.workspaceId, "write");
  if (deleteCopy) {
    if (row.kind === "environment") repo.deleteEnvironment(row.folderId);
    else repo.deleteFolder(row.folderId);
  }
  getDb().delete(installs).where(eq(installs.id, id)).run();
  return { removed: true, deletedCopy: deleteCopy };
}

/** The newest sequence number used for a collection (exported for tests). */
export function latestSeq(folderId: string): number {
  return (
    getDb()
      .select({ seq: max(releases.seq) })
      .from(releases)
      .where(and(eq(releases.folderId, folderId)))
      .get()?.seq ?? 0
  );
}
