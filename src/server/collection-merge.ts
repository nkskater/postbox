/**
 * Shared mechanics for moving one collection (or environment) towards another snapshot without losing
 * what is already there: reading a copy as a snapshot keyed by the other side's node ids, deciding what
 * to do (core planMerge), and applying that decision to the database.
 *
 * Used by installs (LAB-124/180) and by forks and merge requests (LAB-95).
 */
import {
  buildEnvironmentSnapshot,
  buildSnapshot,
  flatten,
  resolveConflicts,
  restoreLocalSecrets,
  type ConflictStrategy,
  type SnapNode,
  type DependencyKind,
  type MergePlan,
  type Snapshot,
} from "@/core/dependencies/model";
import type { FolderDef, FolderNode, RequestDef, TreeNode, Variable } from "@/core/types";
import { HttpError } from "./errors";
import * as repo from "./repo";

/** Where a copy lives, and which of its nodes correspond to which nodes on the other side. */
export interface CopyRef {
  workspaceId: string;
  kind: DependencyKind;
  /** Local collection or environment id. */
  rootId: string;
  /** The other side's node id -> this copy's node id. */
  map: Record<string, string>;
  /** The id the other side uses for the root; only needed for environments. */
  rootSid: string;
}

const reverse = (map: Record<string, string>) =>
  Object.fromEntries(Object.entries(map).map(([sid, id]) => [id, sid]));

/** The copy as a snapshot whose node ids are the other side's. Nodes with no counterpart get `local:<id>`. */
export function snapshotOfCopy(ref: CopyRef, keepSecrets = false): Snapshot | null {
  if (ref.kind === "environment") {
    const env = repo.getEnvironment(ref.rootId);
    if (!env) return null;
    return buildEnvironmentSnapshot({ id: ref.rootSid, name: env.name }, env.variables, keepSecrets);
  }
  const tree = repo.getFolderTree(ref.rootId);
  if (!tree) return null;
  const back = reverse(ref.map);
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
    repo.listVariables(ref.workspaceId, "collection", ref.rootId),
    keepSecrets,
  );
}

/** One line per conflict, for error messages. */
export function describeConflicts(plan: MergePlan): string[] {
  return [
    ...plan.entries.filter((e) => e.action === "conflict").map((e) => `${e.path} (${e.reason})`),
    ...plan.variables.filter((v) => v.action === "conflict").map((v) => `variable ${v.key} (${v.reason})`),
  ];
}

/** Settle a plan's conflicts by `strategy`; `abort` refuses (409) when there are any. */
export function settle(plan: MergePlan, strategy: ConflictStrategy, hint: string): MergePlan {
  if (!plan.conflicts) return plan;
  if (strategy === "abort")
    throw new HttpError(
      409,
      `${plan.conflicts} conflict(s): ${describeConflicts(plan).slice(0, 5).join("; ")}. ${hint}`,
    );
  return resolveConflicts(plan, strategy);
}

const depth = (nodes: ReturnType<typeof flatten>, sid: string) => {
  let d = 0;
  for (let c = nodes.get(sid)?.parent; c; c = nodes.get(c)?.parent) d++;
  return d;
};

/**
 * Apply a settled plan to a copy so it matches `target`, keeping the copy's own credentials. Call inside a
 * transaction. Returns what was done and the updated node map.
 */
export function applyPlan(
  ref: CopyRef,
  plan: MergePlan,
  target: Snapshot,
  local: Snapshot,
  own: Snapshot,
): { counts: { added: number; updated: number; removed: number }; map: Record<string, string> } {
  const incoming = flatten(target);
  const current = flatten(local);
  const ownNodes = flatten(own);
  const map = { ...ref.map };
  const isCollection = ref.kind === "collection";
  const parentLocal = (sid: string | null) => (sid ? (map[sid] ?? ref.rootId) : ref.rootId);
  const counts = { added: 0, updated: 0, removed: 0 };
  const action = new Map(plan.entries.map((e) => [e.sid, e.action]));

  if (!isCollection) {
    // An environment has no tree, only a name and its variables.
    const rootEntry = plan.entries.find((e) => e.sid === target.root.sid);
    if (rootEntry?.action === "update") {
      repo.renameEnvironment(ref.rootId, String(target.root.data.name ?? ""));
      counts.updated++;
    }
  }

  // Parents before children, so a new folder exists before the nodes that go inside it.
  const ordered = isCollection
    ? [...incoming.values()].sort((a, b) => depth(incoming, a.sid) - depth(incoming, b.sid))
    : [];
  for (const node of ordered) {
    const act = action.get(node.sid);
    if (act === "add") {
      const parent = parentLocal(node.parent);
      map[node.sid] =
        node.kind === "folder"
          ? repo.createFolder(ref.workspaceId, parent, node.data as Partial<FolderDef>).id
          : repo.createRequest(ref.workspaceId, parent, node.data as Partial<RequestDef>).id;
      counts.added++;
    } else if (act === "update" && map[node.sid]) {
      const merged = restoreLocalSecrets(node.data, ownNodes.get(node.sid)?.data) as Record<string, unknown>;
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

  // Variables: apply the plan key by key, never overwriting a secret the copy's owner filled in.
  const scope = isCollection ? "collection" : "environment";
  const have = new Map(repo.listVariables(ref.workspaceId, scope, ref.rootId).map((v) => [v.key, v]));
  const wanted = new Map(target.variables.map((v) => [v.key, v]));
  for (const v of plan.variables) {
    if (v.action === "remove") have.delete(v.key);
    else if (v.action === "add" || v.action === "update") {
      const next = wanted.get(v.key);
      if (!next) have.delete(v.key);
      else have.set(v.key, restoreLocalSecrets(next, have.get(v.key)) as Variable);
    }
  }
  repo.replaceVariables(ref.workspaceId, scope, ref.rootId, [...have.values()]);
  return { counts, map };
}

/** Create the folders and requests of `node` under `parent`, recording where each source node went. */
function materializeNode(
  workspaceId: string,
  node: SnapNode,
  parent: string | null,
  map: Record<string, string>,
) {
  if (node.kind === "folder") {
    const folder = repo.createFolder(workspaceId, parent, node.data as Partial<FolderDef>);
    map[node.sid] = folder.id;
    for (const child of node.children) materializeNode(workspaceId, child, folder.id, map);
  } else {
    map[node.sid] = repo.createRequest(workspaceId, parent!, node.data as Partial<RequestDef>).id;
  }
}

/** Create a new collection in `workspaceId` from a snapshot; `name` overrides the collection's name. */
export function materializeCollection(workspaceId: string, snapshot: Snapshot, name?: string) {
  const map: Record<string, string> = {};
  const root = name ? { ...snapshot.root, data: { ...snapshot.root.data, name } } : snapshot.root;
  materializeNode(workspaceId, root, null, map);
  const rootId = map[snapshot.root.sid];
  if (snapshot.variables.length) repo.replaceVariables(workspaceId, "collection", rootId, snapshot.variables);
  return { rootId, map };
}

/** The same snapshot with every node id rewritten through `rename` (ids not in it are kept). */
export function renameSids(snapshot: Snapshot, rename: Record<string, string>): Snapshot {
  const walk = (n: SnapNode): SnapNode => ({
    ...n,
    sid: rename[n.sid] ?? n.sid,
    children: n.children.map(walk),
  });
  return { ...snapshot, root: walk(snapshot.root) };
}

/**
 * The snapshot with the root named `name`. A fork and its parent are free to be called different things,
 * so comparisons give all sides the same root name and a rename is never carried across.
 */
export function withRootName(snapshot: Snapshot, name: string): Snapshot {
  return { ...snapshot, root: { ...snapshot.root, data: { ...snapshot.root.data, name } } };
}
