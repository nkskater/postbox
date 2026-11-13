/**
 * Collections as repository files (src/core/repository/model.ts): read them out, write them back with a
 * guard against overwriting newer work, or create a new collection from them.
 *
 * Git (or any file tool) does the versioning, branching and merging of the files themselves; this module is
 * the bridge. Pushing is refused unless the files were pulled from the collection as it is now, so what a
 * push replaces is always what the author saw.
 */
import { z } from "zod";
import {
  buildEnvironmentSnapshot,
  buildSnapshot,
  checksumOf,
  countNodes,
  diffSnapshots,
  planMerge,
  type MergePlan,
  type Snapshot,
} from "@/core/dependencies/model";
import {
  RepositoryError,
  REPOSITORY_FORMAT,
  environmentToFiles,
  filesToEnvironment,
  filesToSnapshot,
  filesToSpecification,
  repositoryKind,
  snapshotToFiles,
  specificationToFiles,
  type FileSet,
} from "@/core/repository/model";
import { currentCaller } from "./access-context";
import { authorize } from "./authorize";
import { applyPlan, materializeCollection, type CopyRef } from "./collection-merge";
import { getDb } from "./db";
import { HttpError } from "./errors";
import * as repo from "./repo";
import {
  createSpecification,
  getSpecification,
  requireSpecification,
  saveSpecification,
} from "./specifications";
import { assertStorage } from "./usage";

const files = z.record(z.string().max(400), z.string());
export const pushInput = z.object({
  files,
  /** Checksum from the pull the files came from. */
  baseChecksum: z.string().optional(),
  /** Remove requests and folders whose files are gone, and variables that were deleted. */
  prune: z.boolean().default(false),
  /** Push even though the collection changed since the pull. */
  force: z.boolean().default(false),
  dryRun: z.boolean().default(false),
});
export const importInput = z.object({ workspaceId: z.string().min(1), files });

const asHttp = <T>(work: () => T): T => {
  try {
    return work();
  } catch (error) {
    if (error instanceof RepositoryError) throw new HttpError(400, error.message);
    throw error;
  }
};

function currentSnapshot(folderId: string, keepSecrets = false): { snapshot: Snapshot; workspaceId: string } {
  const folder = repo.getFolder(folderId);
  if (!folder) throw new HttpError(404, "Collection not found");
  if (folder.parentId) throw new HttpError(400, "Only a whole collection can be exported, not a folder");
  const tree = repo.getFolderTree(folderId);
  if (!tree) throw new HttpError(404, "Collection not found");
  return {
    snapshot: buildSnapshot(
      tree,
      repo.listVariables(folder.workspaceId, "collection", folderId),
      keepSecrets,
    ),
    workspaceId: folder.workspaceId,
  };
}

/** The collection as files, with a checksum that identifies exactly this state. */
export function exportFiles(folderId: string) {
  const { snapshot, workspaceId } = currentSnapshot(folderId);
  authorize(currentCaller(), workspaceId, "read");
  return {
    format: REPOSITORY_FORMAT,
    collectionId: folderId,
    checksum: checksumOf(snapshot),
    files: snapshotToFiles(snapshot),
  };
}

const identity = (snapshot: Snapshot, workspaceId: string, rootId: string): CopyRef => {
  const map: Record<string, string> = {};
  const walk = (n: Snapshot["root"]) => {
    map[n.sid] = n.sid;
    n.children.forEach(walk);
  };
  walk(snapshot.root);
  return { workspaceId, kind: "collection", rootId, map, rootSid: rootId };
};

/** Put the children of each folder into the order the files record. */
function applyOrder(incoming: Snapshot["root"], map: Record<string, string>) {
  const visit = (node: Snapshot["root"]) => {
    if (node.kind !== "folder") return;
    const folderId = map[node.sid];
    const wanted = node.children.map((c) => map[c.sid]).filter((id): id is string => !!id);
    const have = repo.getFolderChildIds(folderId);
    const sameOrder = wanted.every((id, i) => have.filter((h) => wanted.includes(h))[i] === id);
    if (!sameOrder)
      wanted.forEach((id, i) => {
        const child = node.children.find((c) => map[c.sid] === id)!;
        repo.reorder(child.kind, id, folderId, i);
      });
    node.children.forEach(visit);
  };
  visit(incoming);
}

export function pushFiles(folderId: string, input: z.infer<typeof pushInput>) {
  const { snapshot: current, workspaceId } = currentSnapshot(folderId);
  authorize(currentCaller(), workspaceId, "write");
  const checksum = checksumOf(current);
  if (!input.force) {
    if (!input.baseChecksum)
      throw new HttpError(400, "baseChecksum is required: pull the collection first, or set force");
    if (input.baseChecksum !== checksum)
      throw new HttpError(
        409,
        "The collection changed since these files were pulled. Pull again, merge the changes in your repository, and push.",
      );
  }
  const parsed = asHttp(() => filesToSnapshot(input.files));
  if (parsed.snapshot.root.sid !== folderId && !parsed.snapshot.root.sid.startsWith("new:"))
    throw new HttpError(409, "These files belong to a different collection");
  // Address the files' own root as this collection regardless of how the file named it.
  const incoming: Snapshot = {
    ...parsed.snapshot,
    root: { ...parsed.snapshot.root, sid: folderId },
  };
  let plan: MergePlan = planMerge(current, incoming, current);
  let kept = 0;
  if (!input.prune) {
    // Without prune, what is missing from the files is left alone.
    plan = {
      ...plan,
      entries: plan.entries.map((e) =>
        e.action === "remove" ? (kept++, { ...e, action: "keep" as const }) : e,
      ),
      variables: plan.variables.map((v) =>
        v.action === "remove" ? (kept++, { ...v, action: "keep" as const }) : v,
      ),
    };
  }
  const diff = diffSnapshots(current, incoming);
  if (input.dryRun)
    return { dryRun: true as const, diff, plan, ignored: parsed.ignored, checksum, skippedRemovals: kept };

  assertStorage(workspaceId);
  const own = currentSnapshot(folderId, true).snapshot;
  const applied = getDb().transaction(() => {
    const result = applyPlan(identity(current, workspaceId, folderId), plan, incoming, current, own);
    applyOrder(incoming.root, result.map);
    return result.counts;
  });
  const after = currentSnapshot(folderId).snapshot;
  return {
    dryRun: false as const,
    applied,
    ignored: parsed.ignored,
    skippedRemovals: kept,
    checksum: checksumOf(after),
  };
}

/** Create a new collection, or environment, in a workspace from repository files. */
export function importFiles(input: z.infer<typeof importInput>) {
  authorize(currentCaller(), input.workspaceId, "write");
  assertStorage(input.workspaceId);
  const kind = asHttp(() => repositoryKind(input.files));
  if (kind === "environment") {
    const parsed = asHttp(() => filesToEnvironment(input.files));
    const env = getDb().transaction(() =>
      repo.createEnvironment(input.workspaceId, parsed.snapshot.name, parsed.snapshot.variables),
    );
    const after = buildEnvironmentSnapshot(env, env.variables);
    return {
      kind,
      environmentId: env.id,
      name: env.name,
      variables: env.variables.length,
      ignored: parsed.ignored,
      checksum: checksumOf(after),
    };
  }
  if (kind === "specification") {
    const spec = asHttp(() => filesToSpecification(input.files));
    const created = createSpecification({
      workspaceId: input.workspaceId,
      name: spec.name,
      label: spec.label,
      ...spec.source,
    });
    return {
      kind,
      specificationId: created.id,
      name: created.name,
      revision: created.revision,
      files: spec.source.files.length,
      ignored: spec.ignored,
      checksum: String(created.revision),
    };
  }
  const parsed = asHttp(() => filesToSnapshot(input.files));
  const made = getDb().transaction(() => materializeCollection(input.workspaceId, parsed.snapshot));
  const after = currentSnapshot(made.rootId).snapshot;
  return {
    kind,
    collectionId: made.rootId,
    name: parsed.snapshot.name,
    ...countNodes(parsed.snapshot),
    ignored: parsed.ignored,
    checksum: checksumOf(after),
  };
}

// ------------------------------------------------------------------ environments

function currentEnvironment(id: string, keepSecrets = false) {
  const env = repo.getEnvironment(id);
  if (!env) throw new HttpError(404, "Environment not found");
  return { env, snapshot: buildEnvironmentSnapshot(env, env.variables, keepSecrets) };
}

/** An environment as files (`environment.json`, `variables.json`), with the checksum to push against. */
export function exportEnvironmentFiles(id: string) {
  const { env, snapshot } = currentEnvironment(id);
  authorize(currentCaller(), env.workspaceId, "read");
  return {
    format: REPOSITORY_FORMAT,
    kind: "environment" as const,
    environmentId: id,
    checksum: checksumOf(snapshot),
    files: environmentToFiles(snapshot),
  };
}

export function pushEnvironmentFiles(id: string, input: z.infer<typeof pushInput>) {
  const { env, snapshot: current } = currentEnvironment(id);
  authorize(currentCaller(), env.workspaceId, "write");
  const checksum = checksumOf(current);
  if (!input.force) {
    if (!input.baseChecksum)
      throw new HttpError(400, "baseChecksum is required: pull the environment first, or set force");
    if (input.baseChecksum !== checksum)
      throw new HttpError(
        409,
        "The environment changed since these files were pulled. Pull again, merge the changes in your repository, and push.",
      );
  }
  if (asHttp(() => repositoryKind(input.files)) !== "environment")
    throw new HttpError(409, "These files describe a collection, not an environment");
  const parsed = asHttp(() => filesToEnvironment(input.files));
  if (parsed.snapshot.root.sid !== id && !parsed.snapshot.root.sid.startsWith("new:"))
    throw new HttpError(409, "These files belong to a different environment");
  const incoming: Snapshot = { ...parsed.snapshot, root: { ...parsed.snapshot.root, sid: id } };
  let plan: MergePlan = planMerge(current, incoming, current);
  let kept = 0;
  if (!input.prune)
    plan = {
      ...plan,
      variables: plan.variables.map((v) =>
        v.action === "remove" ? (kept++, { ...v, action: "keep" as const }) : v,
      ),
    };
  if (input.dryRun)
    return {
      dryRun: true as const,
      diff: diffSnapshots(current, incoming),
      plan,
      ignored: parsed.ignored,
      checksum,
      skippedRemovals: kept,
    };
  const own = currentEnvironment(id, true).snapshot;
  const ref: CopyRef = {
    workspaceId: env.workspaceId,
    kind: "environment",
    rootId: id,
    map: {},
    rootSid: id,
  };
  const applied = getDb().transaction(() => applyPlan(ref, plan, incoming, current, own).counts);
  return {
    dryRun: false as const,
    applied,
    ignored: parsed.ignored,
    skippedRemovals: kept,
    checksum: checksumOf(currentEnvironment(id).snapshot),
  };
}

// ------------------------------------------------------------------ specifications

/**
 * A specification as files. Its saved revision is the checksum: a push is only accepted against the
 * revision it was pulled from, and becomes the next revision.
 */
export function exportSpecificationFiles(id: string) {
  requireSpecification(id);
  const spec = getSpecification(id);
  return {
    format: REPOSITORY_FORMAT,
    kind: "specification" as const,
    specificationId: id,
    revision: spec.revision,
    checksum: String(spec.revision),
    files: specificationToFiles({
      id,
      name: spec.name,
      label: spec.label,
      format: spec.format,
      entrypoint: spec.entrypoint,
      files: spec.files,
    }),
  };
}

export function pushSpecificationFiles(id: string, input: z.infer<typeof pushInput>) {
  const row = requireSpecification(id, "write");
  if (!input.force) {
    if (!input.baseChecksum)
      throw new HttpError(400, "baseChecksum is required: pull the specification first, or set force");
    if (input.baseChecksum !== String(row.revision))
      throw new HttpError(
        409,
        "The specification changed since these files were pulled. Pull again, merge the changes in your repository, and push.",
      );
  }
  if (asHttp(() => repositoryKind(input.files)) !== "specification")
    throw new HttpError(409, "These files do not describe a specification");
  const parsed = asHttp(() => filesToSpecification(input.files));
  if (parsed.id && parsed.id !== id)
    throw new HttpError(409, "These files belong to a different specification");
  if (parsed.source.format !== row.format)
    throw new HttpError(409, `A ${row.format} specification cannot become ${parsed.source.format}`);
  const current = getSpecification(id);
  const before = new Map(current.files.map((f) => [f.path, f.content]));
  const after = new Map(parsed.source.files.map((f) => [f.path, f.content]));
  const diff = {
    added: [...after.keys()].filter((p) => !before.has(p)).sort(),
    removed: [...before.keys()].filter((p) => !after.has(p)).sort(),
    changed: [...after.keys()].filter((p) => before.has(p) && before.get(p) !== after.get(p)).sort(),
    entrypoint: current.entrypoint === parsed.source.entrypoint ? null : parsed.source.entrypoint,
    renamed: current.name === parsed.name ? null : parsed.name,
  };
  const identical =
    !diff.added.length && !diff.removed.length && !diff.changed.length && !diff.entrypoint && !diff.renamed;
  if (input.dryRun)
    return {
      dryRun: true as const,
      diff,
      identical,
      ignored: parsed.ignored,
      checksum: String(row.revision),
    };
  if (identical)
    return {
      dryRun: false as const,
      changed: false,
      diff,
      ignored: parsed.ignored,
      checksum: String(row.revision),
      revision: row.revision,
    };
  const saved = saveSpecification(id, {
    expectedRevision: row.revision,
    entrypoint: parsed.source.entrypoint,
    files: parsed.source.files,
    name: parsed.name,
    label: parsed.label,
  });
  return {
    dryRun: false as const,
    changed: true,
    diff,
    ignored: parsed.ignored,
    checksum: String(saved.revision),
    revision: saved.revision,
  };
}

export type { FileSet };
