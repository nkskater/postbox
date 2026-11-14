import { evaluate, type ExpressionContext, type ExpressionBudget } from "./expression";
import {
  jsonBudget,
  parseGraph,
  validateGraph,
  MAX_VALUE_BYTES,
  MAX_TOTAL_VALUE_BYTES,
  MAX_TRACE_BYTES,
  type FlowGraph,
  type FlowNode,
  type Json,
} from "./model";
export interface FlowReference {
  workflowId: string;
  version: number;
}
export interface FlowTrace {
  step: number;
  path: string;
  nodeId: string;
  reference: FlowReference | null;
  type: FlowNode["type"];
  label: string;
  status: "running" | "passed" | "error";
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
  input: Json;
  output?: Json;
  error?: string;
  handled?: boolean;
}
export interface FlowResult {
  status: "passed" | "failed" | "cancelled";
  output: Json;
  error?: string;
  steps: number;
  durationMs: number;
  trace: FlowTrace[];
  traceOmitted: number;
}
export interface FlowRuntime {
  request(
    node: Extract<FlowNode, { type: "request" }>,
    bindings: Record<string, string>,
    signal: AbortSignal,
    reference: FlowReference | null,
  ): Promise<{ ok: boolean; value: Json; error?: string }>;
  subflow(node: Extract<FlowNode, { type: "subflow" }>, signal: AbortSignal): Promise<FlowGraph>;
  beforeStep?: () => void | Promise<void>;
  redact?: (value: Json) => Json;
  onTrace?: (trace: FlowTrace[]) => void;
  signal?: AbortSignal;
  now?: () => number;
  rootReference?: FlowReference;
}
function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
class Semaphore {
  private active = 0;
  private waiting: { resolve: () => void; cleanup: () => void }[] = [];
  constructor(private max: number) {}
  private acquire(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.active < this.max && !this.waiting.length) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const abort = () => {
        const index = this.waiting.indexOf(waiter);
        if (index >= 0) this.waiting.splice(index, 1);
        waiter.cleanup();
        reject(signal.reason);
      };
      const waiter = { resolve, cleanup: () => signal.removeEventListener("abort", abort) };
      signal.addEventListener("abort", abort, { once: true });
      this.waiting.push(waiter);
    });
  }
  async use<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    await this.acquire(signal);
    try {
      signal.throwIfAborted();
      return await abortable(action(), signal);
    } finally {
      const next = this.waiting.shift();
      if (next) {
        next.cleanup();
        next.resolve();
      } else this.active--;
    }
  }
}
/** Pure bounded graph execution. Persistence, HTTP policy, authorization and fixtures are host capabilities. */
export async function executeFlow(raw: FlowGraph, input: Json, runtime: FlowRuntime): Promise<FlowResult> {
  const graph = parseGraph(raw),
    issues = validateGraph(graph);
  if (issues.length)
    throw new Error(
      issues.map((issue) => `${issue.nodeId ? `${issue.nodeId}: ` : ""}${issue.message}`).join("; "),
    );
  jsonBudget(input);
  const now = runtime.now ?? Date.now,
    started = now(),
    controller = new AbortController();
  const signal = runtime.signal ? AbortSignal.any([controller.signal, runtime.signal]) : controller.signal;
  let timedOut = false,
    steps = 0,
    totalBytes = 0,
    traceBytes = 0,
    traceOmitted = 0;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("Workflow deadline exceeded"));
  }, graph.limits.maxDurationMs);
  timer.unref?.();
  const requests = new Semaphore(graph.limits.maxConcurrency),
    fuel: ExpressionBudget = { remaining: 100000 };
  const check = () => {
    signal.throwIfAborted();
    if (now() - started >= graph.limits.maxDurationMs) {
      timedOut = true;
      const error = new Error("Workflow deadline exceeded");
      controller.abort(error);
      throw error;
    }
  };
  let checks = 0;
  fuel.check = () => {
    if (++checks % 64 === 0) check();
  };
  const errorText = (error: unknown) => {
    const raw =
      error instanceof Error ? error.message : typeof error === "string" ? error : "Workflow failed";
    const safe = runtime.redact ? runtime.redact(raw) : raw;
    return typeof safe === "string" ? safe.slice(0, 500) : "Workflow failed";
  };
  const trace: FlowTrace[] = [];
  const preview = (value: Json): Json => {
    const safe = runtime.redact ? runtime.redact(value) : value;
    jsonBudget(safe);
    const text = JSON.stringify(safe);
    return text.length <= 2048 ? safe : { truncated: true, preview: text.slice(0, 2048) };
  };
  const remember = (value: Json): Json => {
    totalBytes += jsonBudget(value, MAX_VALUE_BYTES);
    if (totalBytes > MAX_TOTAL_VALUE_BYTES) throw new Error("Workflow total data budget exceeded");
    return value;
  };
  const notify = () => runtime.onTrace?.(trace);
  const walk = async (
    definition: FlowGraph,
    context: ExpressionContext,
    prefix: string,
    depth: number,
    reference: FlowReference | null,
  ): Promise<Json> => {
    if (depth > 8) throw new Error("Workflow nesting limit exceeded");
    const nodes = new Map(definition.nodes.map((node) => [node.id, node]));
    let id: string | undefined = definition.entry;
    while (id) {
      check();
      if (steps >= graph.limits.maxSteps) throw new Error("Workflow step limit exceeded");
      const step = ++steps;
      if (runtime.beforeStep) await abortable(Promise.resolve(runtime.beforeStep()), signal);
      check();
      const node: FlowNode | undefined = nodes.get(id);
      if (!node) throw new Error(`Missing block: ${id}`);
      const event: FlowTrace = {
        step,
        path: `${prefix}/${node.id}`,
        nodeId: node.id,
        reference,
        type: node.type,
        label: node.label,
        status: "running",
        startedAt: now(),
        input: preview(context.value),
      };
      const reservedBytes = 20000;
      const retained = traceBytes + reservedBytes <= MAX_TRACE_BYTES;
      let accountedBytes = reservedBytes;
      const updateTrace = () => {
        if (retained) {
          const size = jsonBudget(event, MAX_VALUE_BYTES, 32);
          traceBytes += size - accountedBytes;
          accountedBytes = size;
          notify();
        }
      };
      if (retained) {
        trace.push(event);
        traceBytes += reservedBytes;
        notify();
      } else traceOmitted++;
      let next: string | undefined,
        value: Json = context.value;
      const evaluateHere = (expression: Parameters<typeof evaluate>[0]) =>
        evaluate(expression, context, fuel);
      try {
        switch (node.type) {
          case "request": {
            const bindings = Object.fromEntries(
              Object.entries(node.bindings).map(([key, expression]) => {
                const v = evaluateHere(expression);
                return [key, typeof v === "string" ? v : JSON.stringify(v)];
              }),
            );
            jsonBudget(bindings);
            const result = await requests.use(signal, () =>
              runtime.request(node, bindings, signal, reference),
            );
            value = result.value;
            if (!result.ok) {
              if (!node.onError) throw new Error(result.error ?? "Request block failed");
              event.status = "error";
              event.error = errorText(result.error ?? "Request block failed");
              event.handled = true;
              value = { error: event.error, result: value };
              next = node.onError;
            } else next = node.next;
            break;
          }
          case "transform":
            value = evaluateHere(node.expression);
            next = node.next;
            break;
          case "condition": {
            const decision = evaluateHere(node.expression);
            if (typeof decision !== "boolean") throw new Error("Condition must return a boolean");
            context.steps[node.id] = decision;
            next = decision ? node.whenTrue : node.whenFalse;
            break;
          }
          case "loop": {
            const items = evaluateHere(node.items);
            if (!Array.isArray(items)) throw new Error("Loop input must be an array");
            if (items.length > node.maxIterations) throw new Error("Loop item limit exceeded");
            const results: Json[] = new Array(items.length);
            let cursor = 0;
            const body: FlowGraph = { ...definition, entry: node.body };
            const workers = Array.from(
              { length: Math.min(items.length, node.concurrency, graph.limits.maxConcurrency) },
              async () => {
                while (cursor < items.length) {
                  const index = cursor++;
                  results[index] = await walk(
                    body,
                    {
                      ...context,
                      value: items[index],
                      item: items[index],
                      index,
                      steps: { ...context.steps },
                    },
                    `${prefix}/${node.id}[${index}]`,
                    depth + 1,
                    reference,
                  );
                }
              },
            );
            try {
              await Promise.all(workers);
            } catch (error) {
              controller.abort(error);
              await Promise.allSettled(workers);
              throw error;
            }
            value = results;
            next = node.next;
            break;
          }
          case "subflow": {
            const supplied = parseGraph(await abortable(runtime.subflow(node, signal), signal));
            const errors = validateGraph(supplied);
            if (errors.length) throw new Error("Subflow has an invalid graph");
            const subInput = evaluateHere(node.input);
            value = await walk(
              supplied,
              { input: subInput, value: subInput, steps: {} },
              `${prefix}/${node.id}@${node.version}`,
              depth + 1,
              { workflowId: node.workflowId, version: node.version },
            );
            next = node.next;
            break;
          }
          case "output":
            value = evaluateHere(node.expression);
            next = undefined;
            break;
        }
        value = remember(value);
        if (node.type !== "condition") context.steps[node.id] = value;
        context.value = value;
        if (event.status !== "error") event.status = "passed";
        event.output = preview(node.type === "condition" ? context.steps[node.id] : value);
        event.finishedAt = now();
        event.durationMs = Math.max(0, event.finishedAt - event.startedAt);
        updateTrace();
        id = next;
      } catch (error) {
        event.status = "error";
        event.error = errorText(error);
        event.finishedAt = now();
        event.durationMs = Math.max(0, event.finishedAt - event.startedAt);
        updateTrace();
        throw error;
      }
    }
    return context.value;
  };
  try {
    const value = JSON.parse(JSON.stringify(input)) as Json;
    const output = await walk(
      graph,
      { input: value, value, steps: {} },
      "root",
      0,
      runtime.rootReference ?? null,
    );
    return { status: "passed", output, steps, trace, traceOmitted, durationMs: Math.max(0, now() - started) };
  } catch (error) {
    controller.abort(error);
    const message = runtime.signal?.aborted
      ? "Workflow cancelled"
      : timedOut
        ? "Workflow deadline exceeded"
        : errorText(error);
    return {
      status: runtime.signal?.aborted ? "cancelled" : "failed",
      output: null,
      error: message,
      steps,
      trace,
      traceOmitted,
      durationMs: Math.max(0, now() - started),
    };
  } finally {
    clearTimeout(timer);
  }
}
