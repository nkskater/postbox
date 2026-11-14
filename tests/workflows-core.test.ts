import { describe, expect, it, vi } from "vitest";
import { executeFlow, type FlowRuntime } from "@/core/workflows/engine";
import { evaluate } from "@/core/workflows/expression";
import {
  parseGraph,
  starterGraph,
  validateGraph,
  jsonBudget,
  pathExpression as path,
  MAX_TRACE_BYTES,
  type Expression,
  type Json,
  type Operation,
} from "@/core/workflows/model";
const literal = (value: Json): Expression => ({ kind: "literal", value });
const op = (name: Operation, ...args: Expression[]): Expression => ({ kind: "op", op: name, args });
const node = (type: string, id: string, fields: Record<string, unknown> = {}) => ({
  type,
  id,
  label: id,
  position: { x: 0, y: 0 },
  ...fields,
});
const graph = (nodes: unknown[], limits = {}) => parseGraph({ schema: 1, entry: "a", nodes, limits });
const runtime = (overrides: Partial<FlowRuntime> = {}): FlowRuntime => ({
  request: async () => ({ ok: true, value: { status: 200, data: { count: 3 } } }),
  subflow: async () => starterGraph(),
  ...overrides,
});
const context = { input: { count: 3 }, value: [1, 2, 3], steps: {} };

describe("workflow data and expression boundaries", () => {
  it("counts UTF-8 JSON correctly, permits aliases, and rejects cycles or oversized data before serialization", () => {
    const shared = { text: '日本語 " \\ 🚀' },
      value = [shared, shared];
    expect(jsonBudget(value)).toBe(new TextEncoder().encode(JSON.stringify(value)).byteLength);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => jsonBudget(cyclic)).toThrow(/cycles/);
    expect(() => jsonBudget(new Array(20001).fill(null))).toThrow(/item limit/);
    expect(() => jsonBudget(new Array(20000).fill("x".repeat(64000)))).toThrow(/byte/);
  });
  it.each([
    ["add", [2, 3], 5],
    ["subtract", [7, 2], 5],
    ["multiply", [2, 3], 6],
    ["divide", [8, 2], 4],
    ["mod", [7, 2], 1],
    [
      "eq",
      [
        { a: 1, b: 2 },
        { b: 2, a: 1 },
      ],
      true,
    ],
    ["ne", [[1], [2]], true],
    ["gt", [3, 2], true],
    ["gte", [2, 2], true],
    ["lt", [1, 2], true],
    ["lte", [2, 2], true],
    ["and", [true, false], false],
    ["or", [false, true], true],
    ["not", [false], true],
    ["concat", ["a", 2], "a2"],
    ["length", [[1, 2]], 2],
    ["coalesce", [null, "kept"], "kept"],
    ["contains", [[{ a: 1 }], { a: 1 }], true],
    ["get", [{ x: 7 }, "x"], 7],
    ["range", [3], [0, 1, 2]],
    ["join", [["a", "b"], ","], "a,b"],
    ["json", [{ x: 1 }], '{"x":1}'],
    ["parseJson", ['{"x":1}'], { x: 1 }],
    ["sum", [[1, 2, 3]], 6],
    ["compact", [[null, 0, false, "x"]], [0, false, "x"]],
    ["merge", [{ a: 1 }, { b: 2 }], { a: 1, b: 2 }],
  ] as [Operation, Json[], Json][])("evaluates bounded %s expressions", (name, args, expected) => {
    expect(evaluate(op(name, ...args.map(literal)), context)).toEqual(expected);
  });
  it("handles missing paths and lazy guards without touching unsafe or invalid branches", () => {
    expect(evaluate(path("input.missing"), context)).toBeNull();
    expect(evaluate(op("or", literal(true), op("divide", literal(1), literal(0))), context)).toBe(true);
    expect(() => evaluate(path("input.constructor"), context)).toThrow(/Prototype/);
    expect(() => evaluate(op("range", literal(1001)), context)).toThrow(/1000/);
    expect(() =>
      evaluate(op("concat", literal("x".repeat(40000)), literal("x".repeat(40000))), context),
    ).toThrow(/limit/);
  });
  it("limits expression fuel and refuses non-finite arithmetic", () => {
    expect(() => evaluate(op("add", literal(1), literal(2)), context, { remaining: 1 })).toThrow(/limit/);
    expect(() => evaluate(op("multiply", literal(1e308), literal(1e308)), context)).toThrow(/finite/);
  });
});
describe("workflow graph validation", () => {
  it("rejects cycles, duplicates, missing ports, unreachable nodes and unsafe expressions", () => {
    const invalid = graph([
      node("condition", "a", { expression: path("input.constructor"), whenTrue: "a", whenFalse: "missing" }),
      node("output", "unused", { expression: literal(null) }),
    ]);
    expect(
      validateGraph(invalid)
        .map((v) => v.message)
        .join(" "),
    ).toMatch(/reserved.*Cycles.*no target.*unreachable/);
    expect(
      validateGraph(
        graph([
          node("output", "a", { expression: literal(null) }),
          node("output", "a", { expression: literal(null) }),
        ]),
      )[0].message,
    ).toMatch(/Duplicate/);
  });
  it("refuses invalid graphs before any request side effect", async () => {
    const request = vi.fn<FlowRuntime["request"]>(async () => ({ ok: true, value: null }));
    const invalid = graph([
      node("request", "a", { requestId: "saved", next: "b" }),
      node("transform", "b", { expression: op("divide", literal(1)) }),
    ]);
    await expect(executeFlow(invalid, null, runtime({ request }))).rejects.toThrow(/operands/);
    expect(request).not.toHaveBeenCalled();
  });
});
describe("bounded workflow execution", () => {
  it("executes fixture requests, conditions and transformations with reproducible trace identities", async () => {
    const definition = graph([
      node("request", "a", { requestId: "saved", next: "b", bindings: { id: path("input.id") } }),
      node("condition", "b", {
        expression: op("gt", path("value.data.count"), literal(0)),
        whenTrue: "c",
        whenFalse: "d",
      }),
      node("output", "c", {
        expression: { kind: "object", fields: { status: path("steps.a.status"), id: path("input.id") } },
      }),
      node("output", "d", { expression: literal("empty") }),
    ]);
    let tick = 0;
    const request = vi.fn<FlowRuntime["request"]>(async () => ({
      ok: true,
      value: { status: 200, data: { count: 3 } },
    }));
    const result = await executeFlow(definition, { id: 7 }, runtime({ request, now: () => ++tick }));
    expect(result).toMatchObject({ status: "passed", output: { status: 200, id: 7 }, steps: 3 });
    expect(request.mock.calls[0][1]).toEqual({ id: "7" });
    expect(result.trace.map((v) => [v.step, v.nodeId, v.status])).toEqual([
      [1, "a", "passed"],
      [2, "b", "passed"],
      [3, "c", "passed"],
    ]);
  });
  it("rejects truthy non-booleans instead of silently choosing a branch", async () => {
    const definition = graph([
      node("condition", "a", { expression: literal(1), whenTrue: "b", whenFalse: "b" }),
      node("output", "b", { expression: literal("unreachable") }),
    ]);
    expect(await executeFlow(definition, null, runtime())).toMatchObject({
      status: "failed",
      error: "Condition must return a boolean",
    });
  });
  it("handles explicit request-error branches and redacts trace and final errors", async () => {
    const definition = graph([
      node("request", "a", { requestId: "saved", onError: "b", next: "b" }),
      node("output", "b", { expression: path("value.error") }),
    ]);
    const redact = (v: Json): Json => JSON.parse(JSON.stringify(v).replaceAll("private-token", "[redacted]"));
    const request = async () => ({ ok: false, value: null, error: "private-token failed" });
    const handled = await executeFlow(definition, null, runtime({ request, redact }));
    expect(handled.status).toBe("passed");
    expect(handled.trace[0]).toMatchObject({ status: "error", handled: true });
    expect(JSON.stringify(handled)).not.toContain("private-token");
    const fatal = graph([node("request", "a", { requestId: "saved" })]);
    expect(JSON.stringify(await executeFlow(fatal, null, runtime({ request, redact })))).not.toContain(
      "private-token",
    );
  });
  it("bounds nested parallel loops globally and preserves result order despite completion order", async () => {
    const definition = graph(
      [
        node("loop", "a", {
          items: literal([
            ["a", "b"],
            ["c", "d"],
          ]),
          body: "b",
          concurrency: 4,
          next: "d",
        }),
        node("loop", "b", { items: path("value"), body: "c", concurrency: 4 }),
        node("request", "c", { requestId: "saved", bindings: { item: path("item") } }),
        node("output", "d", { expression: path("value") }),
      ],
      { maxConcurrency: 2 },
    );
    let active = 0,
      peak = 0;
    const request = async (_node: unknown, bindings: Record<string, string>) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, bindings.item === "a" ? 10 : 1));
      active--;
      return { ok: true, value: bindings.item };
    };
    const result = await executeFlow(
      definition,
      null,
      runtime({
        request,
        beforeStep: async () => {
          await Promise.resolve();
        },
      }),
    );
    expect(result).toMatchObject({
      status: "passed",
      output: [
        ["a", "b"],
        ["c", "d"],
      ],
    });
    expect(peak).toBe(2);
    expect(new Set(result.trace.map((v) => v.step)).size).toBe(result.steps);
  });
  it("refuses excessive loop inputs before their requests run", async () => {
    const request = vi.fn<FlowRuntime["request"]>(async () => ({ ok: true, value: null }));
    const definition = graph([
      node("loop", "a", { items: literal([1, 2, 3]), body: "b", maxIterations: 2 }),
      node("request", "b", { requestId: "saved" }),
    ]);
    expect(await executeFlow(definition, null, runtime({ request }))).toMatchObject({
      status: "failed",
      error: "Loop item limit exceeded",
    });
    expect(request).not.toHaveBeenCalled();
  });
  it("shares step limits across loops and cannot evade them through subflows", async () => {
    const definition = starterGraph();
    definition.limits.maxSteps = 1;
    expect(await executeFlow(definition, {}, runtime())).toMatchObject({
      status: "failed",
      steps: 1,
      error: "Workflow step limit exceeded",
    });
    const recursive = graph([node("subflow", "a", { workflowId: "self", version: 1, input: path("value") })]);
    expect(await executeFlow(recursive, null, runtime({ subflow: async () => recursive }))).toMatchObject({
      status: "failed",
      error: "Workflow nesting limit exceeded",
    });
  });
  it("cancels outstanding requests on deadlines, including a host that never settles", async () => {
    const definition = graph([node("request", "a", { requestId: "saved" })], { maxDurationMs: 100 });
    expect(
      await executeFlow(definition, null, runtime({ request: () => new Promise(() => {}) })),
    ).toMatchObject({ status: "failed", error: "Workflow deadline exceeded" });
  });
  it("enforces synchronous deadlines and external cancellation before side effects", async () => {
    let tick = 0;
    const definition = starterGraph();
    definition.limits.maxDurationMs = 100;
    expect(await executeFlow(definition, null, runtime({ now: () => (tick += 25) }))).toMatchObject({
      status: "failed",
      error: "Workflow deadline exceeded",
    });
    const controller = new AbortController();
    controller.abort();
    expect(await executeFlow(starterGraph(), {}, runtime({ signal: controller.signal }))).toMatchObject({
      status: "cancelled",
      steps: 0,
    });
  });
  it("fails closed when the actor loses authorization between blocks", async () => {
    let calls = 0;
    const request = vi.fn<FlowRuntime["request"]>(async () => ({ ok: true, value: null }));
    const definition = graph([
      node("transform", "a", { expression: literal(null), next: "b" }),
      node("request", "b", { requestId: "saved" }),
    ]);
    expect(
      await executeFlow(
        definition,
        null,
        runtime({
          request,
          beforeStep: () => {
            if (++calls > 1) throw new Error("Access revoked");
          },
        }),
      ),
    ).toMatchObject({ status: "failed", error: "Access revoked" });
    expect(request).not.toHaveBeenCalled();
  });
  it("bounds trace retention without changing successful results", async () => {
    const definition = graph(
      [
        node("loop", "a", {
          items: literal(Array.from({ length: 500 }, (_, i) => i)),
          body: "b",
          maxIterations: 500,
          next: "d",
        }),
        node("transform", "b", { expression: literal("x".repeat(2000)), next: "c" }),
        node("output", "c", { expression: literal(null) }),
        node("output", "d", { expression: path("value") }),
      ],
      { maxSteps: 2000 },
    );
    const result = await executeFlow(definition, null, runtime());
    expect(result.status).toBe("passed");
    expect(result.output).toHaveLength(500);
    expect(result.traceOmitted).toBeGreaterThan(0);
    expect(new TextEncoder().encode(JSON.stringify(result.trace)).byteLength).toBeLessThanOrEqual(
      MAX_TRACE_BYTES,
    );
  });
  it("bounds cumulative data even when loop results themselves are small", async () => {
    const definition = graph(
      [
        node("loop", "a", { items: literal(Array.from({ length: 100 }, (_, i) => i)), body: "b" }),
        node("transform", "b", { expression: literal("x".repeat(50000)), next: "c" }),
        node("output", "c", { expression: literal(null) }),
      ],
      { maxSteps: 1000 },
    );
    expect(await executeFlow(definition, null, runtime())).toMatchObject({
      status: "failed",
      error: "Workflow total data budget exceeded",
    });
  });
});

it("carries immutable subflow references even when different versions use the same request ID", async () => {
  const definition = graph([
    node("subflow", "a", { workflowId: "shared", version: 1, input: path("value"), next: "b" }),
    node("subflow", "b", { workflowId: "shared", version: 2, input: path("value"), next: "c" }),
    node("output", "c", { expression: { kind: "array", items: [path("steps.a"), path("steps.b")] } }),
  ]);
  const sub = graph([node("request", "a", { requestId: "same-request" })]);
  const result = await executeFlow(
    definition,
    null,
    runtime({
      subflow: async () => sub,
      request: async (_node, _bindings, _signal, reference) => ({ ok: true, value: reference!.version }),
    }),
  );
  expect(result).toMatchObject({ status: "passed", output: [1, 2] });
  expect(result.trace.filter((v) => v.type === "request").map((v) => v.reference)).toEqual([
    { workflowId: "shared", version: 1 },
    { workflowId: "shared", version: 2 },
  ]);
});

it("validates optional range and get operands used by expressions", () => {
  const graph = starterGraph();
  const node = graph.nodes[0];
  if (node.type !== "transform") throw new Error("Expected transform");
  node.expression = {
    kind: "op",
    op: "range",
    args: [
      { kind: "literal", value: 2 },
      { kind: "literal", value: 5 },
    ],
  };
  expect(validateGraph(graph)).toEqual([]);
  expect(evaluate(node.expression, context)).toEqual([2, 3, 4]);
  node.expression = {
    kind: "op",
    op: "get",
    args: [
      { kind: "literal", value: {} },
      { kind: "literal", value: "missing" },
      { kind: "literal", value: "fallback" },
    ],
  };
  expect(validateGraph(graph)).toEqual([]);
  expect(evaluate(node.expression, context)).toBe("fallback");
});
