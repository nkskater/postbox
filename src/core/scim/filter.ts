/**
 * The SCIM filter grammar (RFC 7644 §3.4.2): eq, co, sw and pr comparisons joined by
 * and/or, with quoted values and parentheses. Parsing and matching are pure; a bad filter
 * becomes a 400 ScimError. `search` is accepted as an alias for `filter`, and a bare word
 * matches any searchable text on the resource.
 */
import { ScimError, type ScimRecord } from "./model";

export type FilterNode =
  | { kind: "compare"; op: "eq" | "co" | "sw" | "pr"; path: string; value?: unknown }
  | { kind: "logic"; op: "and" | "or"; left: FilterNode; right: FilterNode };

export type CompareOp = "eq" | "co" | "sw" | "pr";

type Token =
  | { kind: "compare"; text: CompareOp }
  | { kind: "logic"; text: "and" | "or" }
  | { kind: "path" | "quoted" | "paren"; text: string };

const isCompare = (word: string): word is CompareOp =>
  word === "eq" || word === "co" || word === "sw" || word === "pr";
const isLogic = (word: string): word is "and" | "or" => word === "and" || word === "or";

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "(" || ch === ")") {
      tokens.push({ kind: "paren", text: ch });
      i++;
      continue;
    }
    if (ch === '"') {
      let value = "";
      let j = i + 1;
      while (j < input.length && input[j] !== '"') {
        value += input[j] === "\\" && j + 1 < input.length ? input[j + 1] : input[j];
        j++;
      }
      if (j >= input.length) throw new ScimError(400, `Unterminated quoted value in filter "${input}"`);
      tokens.push({ kind: "quoted", text: value });
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < input.length && !/[\s"()[\]]/.test(input[j])) j++;
    const word = input.slice(i, j);
    const lower = word.toLowerCase();
    if (isCompare(lower)) tokens.push({ kind: "compare", text: lower });
    else if (isLogic(lower)) tokens.push({ kind: "logic", text: lower });
    else tokens.push({ kind: "path", text: word });
    i = j;
  }
  return tokens;
}

const coerce = (token: Token): unknown => {
  if (token.kind === "quoted") return token.text;
  if (token.text === "true" || token.text === "false") return token.text === "true";
  if (/^-?\d+(?:\.\d+)?$/.test(token.text)) return Number(token.text);
  return token.text;
};

/** Parse a filter expression; anything malformed answers 400. */
export function parseFilter(input: string): FilterNode {
  const tokens = tokenize(input);
  if (!tokens.length) throw new ScimError(400, "Filter must not be empty");
  const pos = { i: 0 };

  const parseComparison = (): FilterNode => {
    const path = tokens[pos.i];
    if (path?.kind !== "path")
      throw new ScimError(400, `Filter must start with an attribute name in "${input}"`);
    pos.i++;
    const op = tokens[pos.i];
    if (op?.kind !== "compare") throw new ScimError(400, `Expected eq, co, sw or pr after "${path.text}"`);
    pos.i++;
    if (op.text === "pr") return { kind: "compare", op: "pr", path: path.text };
    const value = tokens[pos.i];
    if (!value || (value.kind !== "path" && value.kind !== "quoted"))
      throw new ScimError(400, `Expected a value after "${path.text} ${op.text}"`);
    pos.i++;
    return { kind: "compare", op: op.text, path: path.text, value: coerce(value) };
  };

  const parseGroup = (): FilterNode => {
    if (tokens[pos.i]?.kind === "paren" && tokens[pos.i].text === "(") {
      pos.i++;
      const inner = parseOr();
      if (tokens[pos.i]?.text !== ")")
        throw new ScimError(400, `Unbalanced parentheses in filter "${input}"`);
      pos.i++;
      return inner;
    }
    return parseComparison();
  };

  const parseAnd = (): FilterNode => {
    let left = parseGroup();
    while (tokens[pos.i]?.kind === "logic" && tokens[pos.i].text === "and") {
      pos.i++;
      left = { kind: "logic", op: "and", left, right: parseGroup() };
    }
    return left;
  };

  const parseOr = (): FilterNode => {
    let left = parseAnd();
    while (tokens[pos.i]?.kind === "logic" && tokens[pos.i].text === "or") {
      pos.i++;
      left = { kind: "logic", op: "or", left, right: parseAnd() };
    }
    return left;
  };

  const root = parseOr();
  if (pos.i < tokens.length)
    throw new ScimError(400, `Unexpected token "${tokens[pos.i].text}" in filter "${input}"`);
  return root;
}

/** Attribute values for a dotted path; sections that are arrays contribute each element. */
export function resolveValues(record: unknown, path: string): unknown[] {
  let current: unknown[] = [record];
  for (const segment of path.split(".")) {
    const next: unknown[] = [];
    for (const value of current) {
      if (!value || typeof value !== "object") continue;
      const items = Array.isArray(value) ? value : [value];
      for (const item of items) {
        if (item && typeof item === "object") {
          const found = (item as ScimRecord)[segment];
          if (found !== undefined) next.push(found);
        }
      }
    }
    current = next;
  }
  return current;
}

const text = (value: unknown) =>
  (typeof value === "object" ? JSON.stringify(value) : String(value ?? "")).toLowerCase();

const present = (value: unknown) =>
  value !== undefined && value !== null && value !== "" && !(Array.isArray(value) && value.length === 0);

function compare(found: unknown, op: "eq" | "co" | "sw", expected: unknown): boolean {
  if (op === "co") return text(found).includes(text(expected));
  if (op === "sw") return text(found).startsWith(text(expected));
  if (typeof found === typeof expected && (typeof found === "number" || typeof found === "boolean"))
    return found === expected;
  return text(found) === text(expected);
}

export function matchFilter(node: FilterNode, record: ScimRecord): boolean {
  if (node.kind === "logic")
    return node.op === "and"
      ? matchFilter(node.left, record) && matchFilter(node.right, record)
      : matchFilter(node.left, record) || matchFilter(node.right, record);
  const values = resolveValues(record, node.path);
  const op: CompareOp = node.op;
  if (op === "pr") return values.some(present);
  return values.some((value) => compare(value, op, node.value));
}

/** A bare `search` word: substring match over the searchable text of the resource. */
export function matchSearch(record: ScimRecord, term: string): boolean {
  const needle = term.toLowerCase();
  return Object.values(record).some(function searchValue(value): boolean {
    if (typeof value === "string") return value.toLowerCase().includes(needle);
    if (Array.isArray(value)) return value.some(searchValue);
    if (value && typeof value === "object") return Object.values(value).some(searchValue);
    return false;
  });
}

/** Sort resources by a dotted attribute path; resources without the value keep their order at the end. */
export function sortResources(
  resources: ScimRecord[],
  sortBy: string,
  sortOrder: "asc" | "desc" = "asc",
): ScimRecord[] {
  const direction = sortOrder === "desc" ? -1 : 1;
  const sortKey = (record: ScimRecord) => {
    const [value] = resolveValues(record, sortBy);
    if (typeof value === "number") return { rank: 0, value };
    if (typeof value === "string" || typeof value === "boolean") return { rank: 0, value: String(value) };
    return { rank: 1, value: null };
  };
  return [...resources].sort((a, b) => {
    const left = sortKey(a);
    const right = sortKey(b);
    if (left.rank !== right.rank) return left.rank - right.rank;
    const same =
      typeof left.value === "number" && typeof right.value === "number"
        ? left.value - right.value
        : String(left.value).localeCompare(String(right.value));
    return same * direction;
  });
}
