export type SyncChoice = "keep" | "take";
export interface SyncConflict {
  path: string;
  base: unknown;
  current: unknown;
  incoming: unknown;
  resolved: boolean;
}
export interface SyncChange {
  path: string;
  kind: "add" | "update" | "remove";
  before: unknown;
  after: unknown;
}
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
export function stableJson(value: unknown): string {
  return (
    JSON.stringify(value, (_key, v: unknown) =>
      obj(v)
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, v[k]]),
          )
        : v,
    ) ?? "undefined"
  );
}
export const equal = (a: unknown, b: unknown) => stableJson(a) === stableJson(b);
const token = (key: string) => key.replaceAll("~", "~0").replaceAll("/", "~1");
export function mergeThreeWay(
  base: unknown,
  current: unknown,
  incoming: unknown,
  choices: Record<string, SyncChoice> = {},
  prefix = "",
) {
  const conflicts: SyncConflict[] = [];
  const walk = (b: unknown, c: unknown, n: unknown, path: string, depth = 0): unknown => {
    if (depth > 80) throw Error("Merge depth exceeds 80 levels");
    if (equal(b, n)) return c;
    if (equal(b, c) || equal(c, n)) return n;
    if (obj(b) && obj(c) && obj(n)) {
      const out: Record<string, unknown> = Object.create(null);
      for (const key of new Set([...Object.keys(b), ...Object.keys(c), ...Object.keys(n)])) {
        const value = walk(b[key], c[key], n[key], path + "/" + token(key), depth + 1);
        if (value !== undefined) out[key] = value;
      }
      return out;
    }
    if (conflicts.length >= 200) throw Error("More than 200 conflicts; synchronize smaller changes");
    conflicts.push({
      path,
      base: b ?? null,
      current: c ?? null,
      incoming: n ?? null,
      resolved: !!choices[path],
    });
    return choices[path] === "take" ? n : c;
  };
  const value = walk(base, current, incoming, prefix);
  return { value, conflicts, changes: diffValues(current, value, prefix) };
}
/** Carry only incoming changes onto the last collection baseline, preserving conversion differences. */
export function transferDelta(baseRemote: unknown, baseLocal: unknown, remote: unknown, depth = 0): unknown {
  if (depth > 80) throw Error("Delta depth exceeds 80 levels");
  if (equal(baseRemote, remote)) return baseLocal;
  if (obj(baseRemote) && obj(remote) && obj(baseLocal)) {
    const out: Record<string, unknown> = Object.create(null);
    for (const key of new Set([
      ...Object.keys(baseRemote),
      ...Object.keys(baseLocal),
      ...Object.keys(remote),
    ])) {
      const value = transferDelta(baseRemote[key], baseLocal[key], remote[key], depth + 1);
      if (value !== undefined) out[key] = value;
    }
    return out;
  }
  return remote;
}
export function diffValues(
  before: unknown,
  after: unknown,
  prefix = "",
  out: SyncChange[] = [],
  depth = 0,
): SyncChange[] {
  if (equal(before, after)) return out;
  if (depth > 80) throw Error("Diff depth exceeds 80 levels");
  if (obj(before) && obj(after)) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)]))
      diffValues(before[key], after[key], prefix + "/" + token(key), out, depth + 1);
  } else {
    if (out.length >= 2000) throw Error("More than 2,000 changes; synchronize smaller changes");
    out.push({
      path: prefix,
      kind: before === undefined ? "add" : after === undefined ? "remove" : "update",
      before: before ?? null,
      after: after ?? null,
    });
  }
  return out;
}
