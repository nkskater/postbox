import { z } from "zod";
import type { FolderDef, RequestDef } from "@/core/types";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Expression =
  | { kind: "literal"; value: Json }
  | { kind: "path"; path: string }
  | { kind: "array"; items: Expression[] }
  | { kind: "object"; fields: Record<string, Expression> }
  | { kind: "op"; op: Operation; args: Expression[] };
export const OPERATIONS = [
  "eq",
  "ne",
  "lt",
  "lte",
  "gt",
  "gte",
  "and",
  "or",
  "not",
  "add",
  "subtract",
  "multiply",
  "divide",
  "mod",
  "concat",
  "length",
  "coalesce",
  "contains",
  "get",
  "range",
  "join",
  "json",
  "parseJson",
  "sum",
  "compact",
  "merge",
] as const;
export type Operation = (typeof OPERATIONS)[number];
export const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
export const MAX_VALUE_BYTES = 65536;
export const MAX_GRAPH_BYTES = 262144;
export const MAX_TOTAL_VALUE_BYTES = 4 * 1024 * 1024;
export const MAX_TRACE_BYTES = 524288;

/** Check before recursive validation or evaluation, including programmatic callers. */
export function jsonBudget(value: unknown, maxBytes = MAX_VALUE_BYTES, maxDepth = 24): number {
  const pending: { value: unknown; depth: number; exit?: boolean }[] = [{ value, depth: 0 }];
  const ancestors = new Set<object>();
  const encoder = new TextEncoder();
  let nodes = 0,
    bytes = 0;
  const add = (size: number) => {
    bytes += size;
    if (bytes > maxBytes) throw new Error(`Data exceeds the ${maxBytes}-byte workflow limit`);
  };
  const stringBytes = (text: string) => {
    if (text.length > maxBytes) throw new Error(`Data exceeds the ${maxBytes}-byte workflow limit`);
    return encoder.encode(JSON.stringify(text)).byteLength;
  };
  while (pending.length) {
    const item = pending.pop()!,
      v = item.value;
    if (item.exit) {
      ancestors.delete(v as object);
      continue;
    }
    if (++nodes > 20000 || item.depth > maxDepth) throw new Error("Data nesting or item limit exceeded");
    if (v === null) {
      add(4);
      continue;
    }
    if (typeof v === "string") {
      add(stringBytes(v));
      continue;
    }
    if (typeof v === "boolean") {
      add(v ? 4 : 5);
      continue;
    }
    if (typeof v === "number") {
      if (!Number.isFinite(v)) throw new Error("Numbers must be finite");
      add(String(v).length);
      continue;
    }
    if (
      typeof v !== "object" ||
      (!Array.isArray(v) &&
        Object.getPrototypeOf(v) !== Object.prototype &&
        Object.getPrototypeOf(v) !== null)
    )
      throw new Error("Workflow data must be JSON");
    if (ancestors.has(v)) throw new Error("Workflow data cannot contain cycles");
    ancestors.add(v);
    pending.push({ value: v, depth: item.depth, exit: true });
    if (Array.isArray(v) && v.length > 20000) throw new Error("Data item limit exceeded");
    const entries = Array.isArray(v)
      ? v.map((child) => ["", child] as const)
      : Object.entries(v).filter(([, child]) => child !== undefined);
    if (entries.length > 20000) throw new Error("Data item limit exceeded");
    add(2 + Math.max(0, entries.length - 1));
    for (const [key, child] of entries) {
      if (!Array.isArray(v)) add(stringBytes(key) + 1);
      pending.push({ value: child, depth: item.depth + 1 });
    }
  }
  return bytes;
}

const jsonSchema: z.ZodType<Json> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(jsonSchema),
    z.record(z.string(), jsonSchema),
  ]),
);
export const expressionSchema: z.ZodType<Expression> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("literal"), value: jsonSchema }).strict(),
    z.object({ kind: z.literal("path"), path: z.string().min(1).max(500) }).strict(),
    z.object({ kind: z.literal("array"), items: z.array(expressionSchema).max(1000) }).strict(),
    z.object({ kind: z.literal("object"), fields: z.record(z.string().max(200), expressionSchema) }).strict(),
    z
      .object({ kind: z.literal("op"), op: z.enum(OPERATIONS), args: z.array(expressionSchema).max(64) })
      .strict(),
  ]),
);
const safeId = z
  .string()
  .regex(/^[a-zA-Z0-9_-]{1,64}$/)
  .refine((value) => !FORBIDDEN_KEYS.has(value), "Reserved identifier");
const base = {
  id: safeId,
  label: z.string().max(100),
  position: z
    .object({ x: z.number().min(-100000).max(100000), y: z.number().min(-100000).max(100000) })
    .strict(),
};
const next = z.string().max(64).optional();
export const nodeSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...base,
      type: z.literal("request"),
      requestId: z.string().max(100),
      bindings: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/), expressionSchema).default({}),
      failOnHttpError: z.boolean().default(true),
      failOnTests: z.boolean().default(true),
      next,
      onError: next,
    })
    .strict(),
  z.object({ ...base, type: z.literal("transform"), expression: expressionSchema, next }).strict(),
  z
    .object({
      ...base,
      type: z.literal("condition"),
      expression: expressionSchema,
      whenTrue: z.string().max(64),
      whenFalse: z.string().max(64),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("loop"),
      items: expressionSchema,
      body: z.string().max(64),
      maxIterations: z.number().int().min(1).max(1000).default(100),
      concurrency: z.number().int().min(1).max(4).default(1),
      next,
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("subflow"),
      workflowId: z.string().max(100),
      version: z.number().int().min(1),
      input: expressionSchema,
      next,
    })
    .strict(),
  z.object({ ...base, type: z.literal("output"), expression: expressionSchema }).strict(),
]);
const graphSchema = z
  .object({
    schema: z.literal(1),
    persistVariables: z.boolean().default(false),
    entry: z.string().max(64),
    nodes: z.array(nodeSchema).max(200),
    limits: z
      .object({
        maxSteps: z.number().int().min(1).max(2000).default(500),
        maxDurationMs: z.number().int().min(100).max(120000).default(60000),
        maxConcurrency: z.number().int().min(1).max(4).default(2),
      })
      .strict()
      .default({ maxSteps: 500, maxDurationMs: 60000, maxConcurrency: 2 }),
  })
  .strict();
export type FlowGraph = z.infer<typeof graphSchema>;
export type FlowNode = z.infer<typeof nodeSchema>;
export function parseGraph(value: unknown): FlowGraph {
  jsonBudget(value, MAX_GRAPH_BYTES, 32);
  return graphSchema.parse(value);
}
export interface RequestSnapshot {
  request: RequestDef;
  folderId: string;
  ancestors: FolderDef[];
}
export interface FlowUnit {
  graph: FlowGraph;
  requests: Record<string, RequestSnapshot>;
}
export interface FlowBundle {
  root: FlowUnit;
  subflows: Record<string, FlowUnit>;
}
export type FlowActor =
  { kind: "user"; userId: string; tokenId: string | null } | { kind: "env" } | { kind: "open" };
export type FlowRunStatus = "queued" | "running" | "passed" | "failed" | "cancelled" | "interrupted";
export const referenceKey = (workflowId: string, version: number) => `${workflowId}@${version}`;
export interface GraphIssue {
  nodeId?: string;
  message: string;
}
export function edges(node: FlowNode): { port: string; target: string }[] {
  if (node.type === "condition")
    return [
      { port: "true", target: node.whenTrue },
      { port: "false", target: node.whenFalse },
    ];
  if (node.type === "output") return [];
  return [
    ...(node.type === "loop" ? [{ port: "body", target: node.body }] : []),
    ...(node.next ? [{ port: "next", target: node.next }] : []),
    ...(node.type === "request" && node.onError ? [{ port: "error", target: node.onError }] : []),
  ];
}
export function validateExpression(expression: Expression): string[] {
  const issues: string[] = [],
    pending = [expression];
  const arities: Partial<Record<Operation, number>> = {
    eq: 2,
    ne: 2,
    lt: 2,
    lte: 2,
    gt: 2,
    gte: 2,
    not: 1,
    subtract: 2,
    divide: 2,
    mod: 2,
    length: 1,
    contains: 2,
    join: 2,
    json: 1,
    parseJson: 1,
    sum: 1,
    compact: 1,
  };
  while (pending.length) {
    const value = pending.pop()!;
    if (value.kind === "path") {
      const parts = value.path.split(".");
      if (
        !["input", "value", "steps", "item", "index"].includes(parts[0]) ||
        parts.some((part) => !part || FORBIDDEN_KEYS.has(part))
      )
        issues.push(`Invalid or reserved data path: ${value.path}`);
    } else if (value.kind === "op") {
      if (arities[value.op] !== undefined && value.args.length !== arities[value.op])
        issues.push(`${value.op} expects ${arities[value.op]} operands`);
      if (value.op === "get" && (value.args.length < 2 || value.args.length > 3))
        issues.push("get expects 2 or 3 operands");
      if (value.op === "range" && (value.args.length < 1 || value.args.length > 3))
        issues.push("range expects 1 to 3 operands");
      pending.push(...value.args);
    } else if (value.kind === "object") pending.push(...Object.values(value.fields));
    else if (value.kind === "array") pending.push(...value.items);
  }
  return issues;
}
export function validateGraph(graph: FlowGraph): GraphIssue[] {
  const issues: GraphIssue[] = [],
    nodes = new Map<string, FlowNode>();
  for (const node of graph.nodes) {
    if (nodes.has(node.id)) issues.push({ nodeId: node.id, message: "Duplicate block identifier" });
    nodes.set(node.id, node);
    if (graph.persistVariables && node.type === "loop" && node.concurrency > 1)
      issues.push({ nodeId: node.id, message: "Persistent variable writes require serial loops" });
    const expressions =
      node.type === "request"
        ? Object.values(node.bindings)
        : node.type === "loop"
          ? [node.items]
          : node.type === "subflow"
            ? [node.input]
            : [node.expression];
    for (const expression of expressions)
      for (const message of validateExpression(expression)) issues.push({ nodeId: node.id, message });
    if (node.type === "request" && Object.keys(node.bindings).length > 32)
      issues.push({ nodeId: node.id, message: "At most 32 request bindings are allowed" });
    if (node.type === "request" && !node.requestId)
      issues.push({ nodeId: node.id, message: "Choose a saved request" });
    if (node.type === "subflow" && !node.workflowId)
      issues.push({ nodeId: node.id, message: "Choose a published subflow" });
  }
  if (!nodes.has(graph.entry)) issues.push({ message: "Choose a valid entry block" });
  const visited = new Set<string>(),
    active = new Set<string>();
  const walk = (id: string) => {
    if (active.has(id)) {
      issues.push({ nodeId: id, message: "Cycles must use an explicit bounded Loop block" });
      return;
    }
    if (visited.has(id) || !nodes.has(id)) return;
    visited.add(id);
    active.add(id);
    for (const edge of edges(nodes.get(id)!)) {
      if (!nodes.has(edge.target))
        issues.push({ nodeId: id, message: `${edge.port} connection has no target block` });
      else walk(edge.target);
    }
    active.delete(id);
  };
  walk(graph.entry);
  for (const node of graph.nodes)
    if (!visited.has(node.id))
      issues.push({ nodeId: node.id, message: "Block is unreachable from the entry" });
  return issues;
}
export const pathExpression = (path: string): Expression => ({ kind: "path", path });
export function starterGraph(): FlowGraph {
  return parseGraph({
    schema: 1,
    entry: "input",
    nodes: [
      {
        id: "input",
        type: "transform",
        label: "Input",
        position: { x: 60, y: 100 },
        expression: pathExpression("input"),
        next: "output",
      },
      {
        id: "output",
        type: "output",
        label: "Output",
        position: { x: 400, y: 100 },
        expression: pathExpression("value"),
      },
    ],
  });
}
