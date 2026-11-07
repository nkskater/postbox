/**
 * Three-way merge for a set of source files plus an entrypoint, as used by API specifications. It works a
 * whole file at a time: whichever side changed a file wins, and both changing it differently is a conflict
 * that is never resolved silently. The entrypoint is treated like one more file.
 */
export interface FileState {
  entrypoint: string;
  files: { path: string; content: string }[];
}

/** The entrypoint's key in the comparison; it cannot collide with a real path. */
export const ENTRY = "\u0000entrypoint";

export function toMap(state: FileState): Map<string, string> {
  const map = new Map(state.files.map((f) => [f.path, f.content]));
  map.set(ENTRY, state.entrypoint);
  return map;
}

function fromMap(map: Map<string, string>): FileState {
  const files = [...map.entries()]
    .filter(([key]) => key !== ENTRY)
    .map(([path, content]) => ({ path, content }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return { entrypoint: map.get(ENTRY) ?? "", files };
}

export interface FileDiff {
  added: string[];
  removed: string[];
  changed: string[];
  /** The new entrypoint, when it differs. */
  entrypoint: string | null;
  identical: boolean;
}

/** What changed going from `from` to `to`. */
export function diffFiles(from: FileState, to: FileState): FileDiff {
  const a = toMap(from);
  const b = toMap(to);
  const added: string[] = [];
  const changed: string[] = [];
  for (const [key, value] of b) {
    if (key === ENTRY) continue;
    if (!a.has(key)) added.push(key);
    else if (a.get(key) !== value) changed.push(key);
  }
  const removed = [...a.keys()].filter((key) => key !== ENTRY && !b.has(key));
  const entrypoint = from.entrypoint === to.entrypoint ? null : to.entrypoint;
  return {
    added: added.sort(),
    removed: removed.sort(),
    changed: changed.sort(),
    entrypoint,
    identical: !added.length && !removed.length && !changed.length && entrypoint === null,
  };
}

export type FileAction = "add" | "update" | "remove" | "keep" | "conflict";
export interface FileEntry {
  path: string;
  action: FileAction;
  reason?: string;
}
export interface FileMergePlan {
  entries: FileEntry[];
  conflicts: number;
}

const label = (key: string) => (key === ENTRY ? "the entrypoint" : key);

/** Decide, file by file, how to move `local` towards `incoming`, given the common ancestor `base`. */
export function planFileMerge(base: FileState, incoming: FileState, local: FileState): FileMergePlan {
  const B = toMap(base);
  const I = toMap(incoming);
  const L = toMap(local);
  const entries: FileEntry[] = [];
  for (const key of [...new Set([...B.keys(), ...I.keys(), ...L.keys()])].sort()) {
    const b = B.get(key);
    const i = I.get(key);
    const l = L.get(key);
    const path = label(key);
    if (l === i) entries.push({ path, action: "keep" });
    else if (l === b)
      entries.push({ path, action: i === undefined ? "remove" : l === undefined ? "add" : "update" });
    else if (i === b) entries.push({ path, action: "keep" });
    else
      entries.push({
        path,
        action: "conflict",
        reason:
          i === undefined
            ? "removed upstream but changed here"
            : l === undefined
              ? "removed here but changed upstream"
              : "changed here and upstream",
      });
  }
  return { entries, conflicts: entries.filter((e) => e.action === "conflict").length };
}

export type FileStrategy = "abort" | "keep-local" | "take-incoming";

/** The state after applying the plan; conflicts follow `strategy` (abort must be handled by the caller). */
export function mergeFiles(
  base: FileState,
  incoming: FileState,
  local: FileState,
  strategy: Exclude<FileStrategy, "abort">,
): FileState {
  const B = toMap(base);
  const I = toMap(incoming);
  const L = toMap(local);
  const out = new Map<string, string>();
  for (const key of new Set([...B.keys(), ...I.keys(), ...L.keys()])) {
    const b = B.get(key);
    const i = I.get(key);
    const l = L.get(key);
    let value: string | undefined;
    if (l === i) value = l;
    else if (l === b) value = i;
    else if (i === b) value = l;
    else value = strategy === "keep-local" ? l : i;
    if (value !== undefined) out.set(key, value);
  }
  return fromMap(out);
}
