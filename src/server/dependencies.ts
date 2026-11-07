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
  planMerge,
  type ConflictStrategy,
  type DependencyKind,
  type Snapshot,
} from "@/core/dependencies/model";
import { currentCaller } from "./access-context";
import { authorize, workspaceRole } from "./authorize";
import { getDb, schema } from "./db";
import { newId } from "./defaults";
import { HttpError } from "./errors";
import { applyPlan, materializeCollection, settle, snapshotOfCopy, type CopyRef } from "./collection-merge";
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

export function installRelease(input: z.infer<typeof installInput>) {
  const caller = currentCaller();
  authorize(caller, input.workspaceId, "write");
  const release = visibleRelease(input.releaseId);
  if (release.revokedAt) throw new HttpError(409, `This version was withdrawn: ${release.revokedReason}`);
  if (release.workspaceId === input.workspaceId)
    throw new HttpError(409, "This collection already lives in this workspace; install it into another one");
  assertStorage(input.workspaceId);
  const { snapshot } = rootAndBase(release);
  const map: Record<string, string> = {};
  return getDb().transaction(() => {
    let folderId: string;
    if (release.kind === "environment") {
      folderId = repo.createEnvironment(input.workspaceId, snapshot.name, snapshot.variables).id;
    } else {
      const made = materializeCollection(input.workspaceId, snapshot);
      folderId = made.rootId;
      Object.assign(map, made.map);
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

/** The local copy as a snapshot whose node ids are the source's, so it can be compared with a release. */
const copyOf = (row: InstallRow): CopyRef => ({
  workspaceId: row.workspaceId,
  kind: row.kind,
  rootId: row.folderId,
  map: row.nodeMap,
  rootSid: row.baseSnapshot.root.sid,
});
const localSnapshot = (row: InstallRow, keepSecrets = false) => snapshotOfCopy(copyOf(row), keepSecrets);

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

export function updateInstall(id: string, input: z.infer<typeof updateInput>) {
  const row = requireInstall(id);
  authorize(currentCaller(), row.workspaceId, "write");
  const target = targetRelease(row, input.releaseId);
  if (target.revokedAt) throw new HttpError(409, `This version was withdrawn: ${target.revokedReason}`);
  if (target.id === row.releaseId) throw new HttpError(409, `Already on ${target.version}`);
  const local = localSnapshot(row);
  if (!local) throw new HttpError(409, "The local copy no longer exists");
  const plan = settle(
    planMerge(row.baseSnapshot, target.snapshot, local),
    input.strategy,
    "Retry with strategy keep-local or take-incoming.",
  );
  // The user's own credentials, which a comparison snapshot leaves out but an update must not lose.
  const own = localSnapshot(row, true)!;

  const applied = getDb().transaction(() => {
    const result = applyPlan(copyOf(row), plan, target.snapshot, local, own);
    getDb()
      .update(installs)
      .set({
        releaseId: target.id,
        version: target.version,
        checksum: target.checksum,
        baseSnapshot: target.snapshot,
        nodeMap: result.map,
        updatedAt: Date.now(),
      })
      .where(eq(installs.id, id))
      .run();
    return result.counts;
  });
  return { applied, dependency: installView(requireInstall(id)) };
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
