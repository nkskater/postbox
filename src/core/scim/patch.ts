/**
 * The PATCH half of SCIM (RFC 7644 §3.5.1): add, remove and replace operations over
 * attribute paths, including bracket filters such as `members[value eq "x"]`.
 *
 * Pure data functions: the server layer decides which paths it must act on itself
 * (workspace roles behind `members`) before applying the rest here.
 */
import { matchFilter, parseFilter, type FilterNode } from "./filter";
import { ScimError, type ScimRecord } from "./model";

export interface PatchOperation {
  op: "add" | "remove" | "replace";
  path?: string;
  value?: unknown;
}

export interface ParsedPath {
  /** Attribute segments, e.g. `name.givenName` → ["name", "givenName"]. */
  segments: string[];
  /** A `[filter]` attached to the last segment, as `remove` on a multi-valued attribute. */
  filter?: FilterNode;
}

export function parsePatchPath(path: string): ParsedPath {
  const match = /^([^[\]]+)(?:\[([^\]]*)\])?$/.exec(path.trim());
  if (!match) throw new ScimError(400, `Invalid PATCH path "${path}"`);
  const segments = match[1].split(".").filter(Boolean);
  if (segments.some((segment) => ["__proto__", "prototype", "constructor"].includes(segment)))
    throw new ScimError(400, "Invalid PATCH attribute");
  if (!segments.length) throw new ScimError(400, `Invalid PATCH path "${path}"`);
  return { segments, filter: match[2] ? parseFilter(match[2]) : undefined };
}

const isRecord = (value: unknown): value is ScimRecord =>
  !!value && typeof value === "object" && !Array.isArray(value);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Walks a dotted path from a record; array sections contribute each element (or an index). */
function walk(root: ScimRecord, segments: string[]): unknown[] {
  let current: unknown[] = [root];
  for (const segment of segments) {
    const next: unknown[] = [];
    for (const value of current) {
      if (Array.isArray(value)) {
        if (/^\d+$/.test(segment)) {
          const item = value[Number(segment)];
          if (item !== undefined) next.push(item);
        } else
          for (const item of value)
            if (isRecord(item) && item[segment] !== undefined) next.push(item[segment]);
      } else if (isRecord(value) && value[segment] !== undefined) next.push(value[segment]);
    }
    current = next;
  }
  return current;
}

/** The object the final segment of a path lives on, creating objects as needed. */
function parentOf(root: ScimRecord, segments: string[]): ScimRecord {
  let node: unknown = root;
  for (const segment of segments.slice(0, -1)) {
    if (Array.isArray(node)) {
      if (!/^\d+$/.test(segment)) throw new ScimError(400, `PATCH path does not resolve at "${segment}"`);
      node = node[Number(segment)];
    } else if (isRecord(node)) {
      if (node[segment] === undefined) node[segment] = {};
      node = node[segment];
    } else throw new ScimError(400, `PATCH path does not resolve at "${segment}"`);
    if (node === undefined) throw new ScimError(400, `PATCH path does not resolve at "${segment}"`);
  }
  if (!isRecord(node)) throw new ScimError(400, `PATCH path "${segments.join(".")}" must target an object`);
  return node;
}

/** Apply one operation to a record (mutating it), as SCIM PATCH semantics allow. */
export function applyOperation(record: ScimRecord, operation: PatchOperation): void {
  const { op, path, value } = operation;
  if ((op === "add" || op === "replace") && !path) {
    if (!isRecord(value)) throw new ScimError(400, "add without a path requires an object value");
    for (const key of Object.keys(value)) parsePatchPath(key);
    Object.assign(record, value);
    return;
  }
  if (!path) throw new ScimError(400, `${op} needs a path`);
  const parsed = parsePatchPath(path);
  if (parsed.filter) {
    if (op !== "remove") throw new ScimError(400, "Filtered PATCH supports remove only");
    // The `[filter]` selects elements of the multi-valued attribute the path leads to.
    const target = walk(record, parsed.segments);
    const array = target[0];
    if (!Array.isArray(array)) throw new ScimError(400, `PATCH filter "${path}" must target an array`);
    for (let i = array.length - 1; i >= 0; i--)
      if (isRecord(array[i]) && matchFilter(parsed.filter, array[i])) array.splice(i, 1);
    return;
  }

  const parent = parentOf(record, parsed.segments);
  const key = parsed.segments.at(-1)!;
  if (Array.isArray(parent)) {
    if (!/^\d+$/.test(key)) throw new ScimError(400, `PATCH path "${path}" must target an array index`);
    const index = Number(key);
    if (op === "remove") parent.splice(index, 1);
    else if (op === "replace") parent[index] = value;
    else throw new ScimError(400, `add on an array index "${path}" needs a filter`);
    return;
  }
  const existing = parent[key];
  if (op === "remove") {
    if (Array.isArray(existing) && value !== undefined)
      parent[key] = existing.filter((item) => !same(item, value));
    else delete parent[key];
    return;
  }
  if (op === "replace") {
    parent[key] = value;
    return;
  }
  if (Array.isArray(existing)) parent[key] = [...existing, ...(Array.isArray(value) ? value : [value])];
  else if (isRecord(existing) && isRecord(value)) Object.assign(existing, value);
  else parent[key] = Array.isArray(value) ? [...value] : value;
}

export function applyOperations(record: ScimRecord, operations: PatchOperation[]): ScimRecord {
  // A deep copy: operations must not mutate the record they were handed, or the caller's
  // view of "before" changes under them.
  const result = structuredClone(record);
  for (const operation of operations) applyOperation(result, operation);
  return result;
}
