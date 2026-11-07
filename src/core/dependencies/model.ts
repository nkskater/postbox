/**
 * Versioned, shareable snapshots of a collection, and the arithmetic for installing and updating them:
 * secret-free snapshots, checksums, diffs, and a three-way merge that keeps local edits.
 *
 * Pure functions only: no database, no HTTP. The server supplies the trees and applies the plans.
 */
import { createHash } from "node:crypto";
import type { AuthConfig, BodyConfig, FolderNode, TreeNode, Variable } from "../types";
import {
  SENSITIVE_NAME,
  isReferenceOnly,
  restoreMissingCredentials,
  withoutAuthCredentials,
  withoutUploadBytes,
} from "../retention";

export const SNAPSHOT_SCHEMA = 1;
/** What a release contains. A collection carries folders and requests; an environment only variables. */
export const DEPENDENCY_KINDS = ["collection", "environment"] as const;
export type DependencyKind = (typeof DEPENDENCY_KINDS)[number];
export const RELEASE_VISIBILITIES = ["workspace", "instance"] as const;
export type ReleaseVisibility = (typeof RELEASE_VISIBILITIES)[number];
export const RELEASE_LIMITS = {
  versionPattern: /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/,
  notes: 2000,
  snapshotBytes: 8 * 1024 * 1024,
};

/** One folder or request. `sid` is the node's id in the source collection and is stable across releases. */
export interface SnapNode {
  sid: string;
  kind: "folder" | "request";
  /** Everything about the node except its identity and children, with secrets removed. */
  data: Record<string, unknown>;
  children: SnapNode[];
}
export interface Snapshot {
  schema: typeof SNAPSHOT_SCHEMA;
  name: string;
  root: SnapNode;
  variables: Variable[];
}

// ------------------------------------------------------------------ secrets

type Json = unknown;
const isObject = (v: Json): v is Record<string, Json> => !!v && typeof v === "object" && !Array.isArray(v);

/** Remove credentials from anything that is about to be shared. References like {{vault:x}} are kept. */
export function stripSecrets<T>(value: T): T {
  const strip = (v: Json): Json => {
    if (Array.isArray(v)) return v.map(strip);
    if (!isObject(v)) return v;
    // A variable marked secret is a secret whatever its name.
    if (v.type === "secret" && typeof v.key === "string" && typeof v.value === "string")
      return { ...v, value: "" };
    if (
      typeof v.key === "string" &&
      typeof v.value === "string" &&
      SENSITIVE_NAME.test(v.key) &&
      !isReferenceOnly(v.value)
    )
      return { ...Object.fromEntries(Object.entries(v).map(([k, x]) => [k, strip(x)])), value: "" };
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => {
        if (k === "auth" && isObject(x) && typeof x.type === "string")
          return [k, withoutAuthCredentials(x as unknown as AuthConfig)];
        if (k === "body" && isObject(x) && typeof x.mode === "string")
          return [k, strip(withoutUploadBytes(x as unknown as BodyConfig))];
        if (k === "raw" && typeof x === "string") return [k, stripRawJson(x)];
        return [k, strip(x)];
      }),
    );
  };
  return strip(value) as T;
}

/** Blank sensitive-named string members of a raw JSON body; other text is left as written. */
function stripRawJson(raw: string): string {
  let parsed: Json;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (!parsed || typeof parsed !== "object") return raw;
  let changed = false;
  const walk = (v: Json): Json => {
    if (Array.isArray(v)) return v.map(walk);
    if (!isObject(v)) return v;
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => {
        if (SENSITIVE_NAME.test(k) && typeof x === "string" && x && !isReferenceOnly(x)) {
          changed = true;
          return [k, ""];
        }
        return [k, walk(x)];
      }),
    );
  };
  const out = walk(parsed);
  return changed ? JSON.stringify(out, null, 2) : raw;
}

/**
 * Put the local user's own credentials back into incoming data, so an update never blanks them.
 * Pairs auth blocks, and key/value rows by key.
 */
export function restoreLocalSecrets<T>(incoming: T, local: Json): T {
  const walk = (inc: Json, loc: Json): Json => {
    if (Array.isArray(inc)) {
      return inc.map((item, i) => {
        if (isObject(item) && typeof item.key === "string" && Array.isArray(loc)) {
          const match = loc.find((l) => isObject(l) && l.key === item.key);
          return walk(item, match ?? loc[i]);
        }
        return walk(item, Array.isArray(loc) ? loc[i] : undefined);
      });
    }
    if (!isObject(inc)) return inc;
    const l = isObject(loc) ? loc : {};
    const out: Record<string, Json> = {};
    for (const [k, x] of Object.entries(inc)) {
      if (k === "auth" && isObject(x) && isObject(l.auth) && typeof x.type === "string")
        out[k] = restoreMissingCredentials(x as unknown as AuthConfig, l.auth as unknown as AuthConfig);
      else if (
        k === "value" &&
        x === "" &&
        typeof l.value === "string" &&
        l.value &&
        typeof inc.key === "string" &&
        SENSITIVE_NAME.test(inc.key)
      )
        out[k] = l.value;
      else if (k === "value" && x === "" && inc.type === "secret" && typeof l.value === "string")
        out[k] = l.value;
      else out[k] = walk(x, l[k]);
    }
    return out;
  };
  return walk(incoming, local) as T;
}

// ------------------------------------------------------------------ snapshots

/** Stable JSON: object keys sorted, so equal content always hashes equally. */
export function canonicalJson(value: Json): string {
  const sort = (v: Json): Json => {
    if (Array.isArray(v)) return v.map(sort);
    if (isObject(v))
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .filter((k) => v[k] !== undefined)
          .map((k) => [k, sort(v[k])]),
      );
    return v;
  };
  return JSON.stringify(sort(value));
}
export const checksumOf = (value: Json) => createHash("sha256").update(canonicalJson(value)).digest("hex");

/** Fields that belong to where a node lives here, not to the node itself. */
const LOCAL_FIELDS = [
  "id",
  "kind",
  "children",
  "folderId",
  "workspaceId",
  "parentId",
  "sort",
  "createdAt",
  "updatedAt",
];
const nodeData = (node: TreeNode, keepSecrets: boolean): Record<string, unknown> => {
  const rest = { ...(node as unknown as Record<string, unknown>) };
  for (const field of LOCAL_FIELDS) delete rest[field];
  return keepSecrets ? rest : stripSecrets(rest);
};
const toSnapNode = (node: TreeNode, keepSecrets: boolean): SnapNode => ({
  sid: node.id,
  kind: node.kind,
  data: nodeData(node, keepSecrets),
  children: node.kind === "folder" ? node.children.map((c) => toSnapNode(c, keepSecrets)) : [],
});

/**
 * `keepSecrets` is for comparing against the user's own copy so their credentials can be put back after
 * an update; a snapshot that is stored or shared never has it.
 */
export function buildSnapshot(tree: FolderNode, variables: Variable[], keepSecrets = false): Snapshot {
  return {
    schema: SNAPSHOT_SCHEMA,
    name: tree.name,
    root: toSnapNode(tree, keepSecrets),
    variables: (keepSecrets ? variables : stripSecrets(variables)).map(({ id: _id, ...v }) => v as Variable),
  };
}

/**
 * An environment is a snapshot with a single root node (its name) and its variables, so the same diff
 * and merge rules apply. Secret variable values are blanked.
 */
export function buildEnvironmentSnapshot(
  env: { id: string; name: string },
  variables: Variable[],
  keepSecrets = false,
): Snapshot {
  return {
    schema: SNAPSHOT_SCHEMA,
    name: env.name,
    root: { sid: env.id, kind: "folder", data: { name: env.name }, children: [] },
    variables: (keepSecrets ? variables : stripSecrets(variables)).map(({ id: _id, ...v }) => v as Variable),
  };
}

export function countNodes(snapshot: Snapshot): { folders: number; requests: number } {
  let folders = 0;
  let requests = 0;
  const walk = (n: SnapNode) => {
    if (n.kind === "folder") folders++;
    else requests++;
    n.children.forEach(walk);
  };
  walk(snapshot.root);
  return { folders: folders - 1, requests };
}

/** A node as the comparison sees it: where it sits and what it contains. */
export interface FlatNode {
  sid: string;
  kind: "folder" | "request";
  parent: string | null;
  /** Position among its siblings; used to place new nodes, never to detect changes. */
  order: number;
  path: string;
  data: Record<string, unknown>;
}
export function flatten(snapshot: Snapshot): Map<string, FlatNode> {
  const out = new Map<string, FlatNode>();
  const walk = (n: SnapNode, parent: string | null, order: number, trail: string[]) => {
    const name = String(n.data.name ?? "");
    const path = [...trail, name].join(" / ");
    out.set(n.sid, { sid: n.sid, kind: n.kind, parent, order, path, data: n.data });
    n.children.forEach((c, i) => walk(c, n.sid, i, n.sid === snapshot.root.sid ? [] : [...trail, name]));
  };
  walk(snapshot.root, null, 0, []);
  return out;
}

const same = (a: Json, b: Json) => canonicalJson(a) === canonicalJson(b);
const nodeSame = (a: FlatNode, b: FlatNode) => a.parent === b.parent && same(a.data, b.data);
const changedFields = (a: FlatNode, b: FlatNode): string[] => {
  const keys = new Set([...Object.keys(a.data), ...Object.keys(b.data)]);
  const fields = [...keys].filter((k) => !same(a.data[k], b.data[k])).sort();
  if (a.parent !== b.parent) fields.push("location");
  return fields;
};

// ------------------------------------------------------------------ diff

export interface NodeChange {
  sid: string;
  kind: "folder" | "request";
  path: string;
  fields?: string[];
}
export interface VariableChange {
  key: string;
  change: "added" | "removed" | "changed";
}
export interface SnapshotDiff {
  added: NodeChange[];
  removed: NodeChange[];
  changed: NodeChange[];
  variables: VariableChange[];
  identical: boolean;
}

function diffVariables(a: Variable[], b: Variable[]): VariableChange[] {
  const A = new Map(a.map((v) => [v.key, v]));
  const B = new Map(b.map((v) => [v.key, v]));
  const out: VariableChange[] = [];
  for (const [key, v] of B) {
    const before = A.get(key);
    if (!before) out.push({ key, change: "added" });
    else if (!same({ ...before, id: undefined }, { ...v, id: undefined }))
      out.push({ key, change: "changed" });
  }
  for (const key of A.keys()) if (!B.has(key)) out.push({ key, change: "removed" });
  return out.sort((x, y) => x.key.localeCompare(y.key));
}

/** What changed going from `from` to `to`. */
export function diffSnapshots(from: Snapshot, to: Snapshot): SnapshotDiff {
  const A = flatten(from);
  const B = flatten(to);
  const added: NodeChange[] = [];
  const removed: NodeChange[] = [];
  const changed: NodeChange[] = [];
  for (const [sid, node] of B) {
    const before = A.get(sid);
    if (!before) added.push({ sid, kind: node.kind, path: node.path });
    else if (!nodeSame(before, node))
      changed.push({ sid, kind: node.kind, path: node.path, fields: changedFields(before, node) });
  }
  for (const [sid, node] of A) if (!B.has(sid)) removed.push({ sid, kind: node.kind, path: node.path });
  const variables = diffVariables(from.variables, to.variables);
  return {
    added,
    removed,
    changed,
    variables,
    identical: !added.length && !removed.length && !changed.length && !variables.length,
  };
}

// ------------------------------------------------------------------ three-way merge

export type MergeAction = "add" | "update" | "remove" | "keep" | "conflict";
export interface MergeEntry {
  sid: string;
  kind: "folder" | "request";
  path: string;
  action: MergeAction;
  /** Why a conflict arose, in plain words. */
  reason?: string;
}
export interface MergePlan {
  entries: MergeEntry[];
  variables: { key: string; action: MergeAction; reason?: string }[];
  conflicts: number;
}

/**
 * Decide, node by node, how to move a local copy from `base` (what was installed) to `incoming`.
 * `local` is the copy as it is now. Whichever side changed a node wins; both changing it differently is a
 * conflict. Nodes that exist only locally are never touched.
 */
export function planMerge(base: Snapshot, incoming: Snapshot, local: Snapshot): MergePlan {
  const B = flatten(base);
  const I = flatten(incoming);
  const L = flatten(local);
  const entries: MergeEntry[] = [];
  const localOnlyBelow = (sid: string) =>
    [...L.values()].some((n) => !B.has(n.sid) && isBelow(L, n.sid, sid));
  for (const [sid, inc] of I) {
    const bas = B.get(sid);
    const loc = L.get(sid);
    const entry = (action: MergeAction, reason?: string): MergeEntry => ({
      sid,
      kind: inc.kind,
      path: inc.path,
      action,
      reason,
    });
    if (!bas) {
      entries.push(entry(loc ? "keep" : "add"));
    } else if (!loc) {
      // Deleted locally: leave it deleted if upstream did not touch it, otherwise ask.
      entries.push(
        nodeSame(bas, inc) ? entry("keep") : entry("conflict", "removed here but changed upstream"),
      );
    } else if (nodeSame(loc, inc)) {
      entries.push(entry("keep"));
    } else if (nodeSame(loc, bas)) {
      entries.push(entry("update"));
    } else if (nodeSame(bas, inc)) {
      entries.push(entry("keep"));
    } else {
      entries.push(
        entry(
          "conflict",
          `changed here (${changedFields(bas, loc).join(", ")}) and upstream (${changedFields(bas, inc).join(", ")})`,
        ),
      );
    }
  }
  for (const [sid, bas] of B) {
    if (I.has(sid)) continue;
    const loc = L.get(sid);
    const entry = (action: MergeAction, reason?: string): MergeEntry => ({
      sid,
      kind: bas.kind,
      path: bas.path,
      action,
      reason,
    });
    if (!loc) entries.push(entry("keep"));
    else if (!nodeSame(bas, loc)) entries.push(entry("conflict", "removed upstream but changed here"));
    else if (bas.kind === "folder" && localOnlyBelow(sid))
      entries.push(entry("conflict", "removed upstream but you added items inside it"));
    else entries.push(entry("remove"));
  }

  const vars = (xs: Variable[]) => new Map(xs.map((v) => [v.key, { ...v, id: undefined }]));
  const vb = vars(base.variables);
  const vi = vars(incoming.variables);
  const vl = vars(local.variables);
  const variables: MergePlan["variables"] = [];
  for (const key of new Set([...vb.keys(), ...vi.keys()])) {
    const b = vb.get(key);
    const i = vi.get(key);
    const l = vl.get(key);
    const same3 = (x?: Json, y?: Json) =>
      (x === undefined && y === undefined) || (x !== undefined && y !== undefined && same(x, y));
    if (same3(l, i)) variables.push({ key, action: "keep" });
    else if (same3(l, b)) variables.push({ key, action: i ? (l ? "update" : "add") : "remove" });
    else if (same3(b, i)) variables.push({ key, action: "keep" });
    else variables.push({ key, action: "conflict", reason: "changed here and upstream" });
  }
  const conflicts =
    entries.filter((e) => e.action === "conflict").length +
    variables.filter((v) => v.action === "conflict").length;
  return { entries, variables, conflicts };
}

function isBelow(nodes: Map<string, FlatNode>, sid: string, ancestor: string): boolean {
  let cursor = nodes.get(sid)?.parent ?? null;
  while (cursor) {
    if (cursor === ancestor) return true;
    cursor = nodes.get(cursor)?.parent ?? null;
  }
  return false;
}

export type ConflictStrategy = "abort" | "keep-local" | "take-incoming";
export const CONFLICT_STRATEGIES: readonly ConflictStrategy[] = ["abort", "keep-local", "take-incoming"];
/** Settle every conflict according to `strategy`, leaving only add/update/remove/keep. */
export function resolveConflicts(plan: MergePlan, strategy: Exclude<ConflictStrategy, "abort">): MergePlan {
  const take = strategy === "take-incoming";
  return {
    conflicts: 0,
    entries: plan.entries.map((e) => {
      if (e.action !== "conflict") return e;
      const removedUpstream = e.reason?.includes("removed upstream");
      const removedHere = e.reason?.startsWith("removed here");
      if (!take) return { ...e, action: "keep" };
      return { ...e, action: removedUpstream ? "remove" : removedHere ? "add" : "update" };
    }),
    variables: plan.variables.map((v) =>
      v.action !== "conflict" ? v : { ...v, action: take ? "update" : "keep" },
    ),
  };
}
