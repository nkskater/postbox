/**
 * Collection runner engine: runs every request of a folder/collection
 * sequentially for N iterations, with iteration data, delays, stop-on-failure
 * and setNextRequest support. Shared by the web runner, the CLI, the scheduler
 * and the MCP server.
 */
import type {
  ConsoleEntry,
  DataTable,
  FolderDef,
  FolderNode,
  RequestDef,
  RunOptions,
  TestResult,
} from "../types";
import {
  execute,
  executionPassed,
  type ExecuteResult,
  type ScriptError,
  type SavedRequestResolver,
} from "../executor";
import { recordExecution, type ExecutionDetails } from "./details";
import type { CookieJarStore } from "../http/cookies";
import type { HostPolicy } from "../http/policy";
import type { RequestDefaults } from "../http/prepare";
import type { ScriptLimits } from "../scripts/sandbox";
import { redactStoredValue, type VariableScopes } from "../variables/resolver";

export interface RunItem {
  request: RequestDef;
  /** Ancestor folders, collection first. */
  ancestors: FolderDef[];
  /** Folder path for display, e.g. "Users / Admin". */
  path: string;
}

export interface RunResult {
  iteration: number;
  sequence: number;
  requestId: string;
  name: string;
  path: string;
  method: string;
  url: string;
  status: number | null;
  statusText: string | null;
  timeMs: number | null;
  size: number | null;
  tests: TestResult[];
  scriptErrors: ScriptError[];
  error: string | null;
  passed: boolean;
  skipped: boolean;
  /** Truncated response body for the results view. */
  responseBody?: string;
  responseHeaders?: [string, string][];
  executionDetails?: ExecutionDetails;
}

export interface RunSummary {
  name: string;
  status: "passed" | "failed" | "cancelled" | "error";
  iterations: number;
  totalRequests: number;
  failedRequests: number;
  totalTests: number;
  passedTests: number;
  failedTests: number;
  durationMs: number;
  startedAt: number;
  finishedAt: number;
  results: RunResult[];
  error?: string;
}

export type RunEvent =
  | { type: "start"; name: string; iterations: number; total: number; startedAt: number }
  | { type: "iteration"; iteration: number; data: Record<string, string> }
  | { type: "request"; iteration: number; sequence: number; name: string }
  | { type: "result"; result: RunResult }
  | { type: "log"; entries: ConsoleEntry[] }
  | { type: "done"; summary: Omit<RunSummary, "results"> };

export interface RunCollectionInput {
  root: FolderNode;
  resolveRequest?: SavedRequestResolver;
  /** Folders above `root` (when running a sub-folder), collection first. */
  ancestors?: FolderDef[];
  scopes: VariableScopes;
  options: RunOptions;
  data?: DataTable | null;
  /** Restrict to these request ids (in tree order). */
  selectedRequestIds?: string[] | null;
  cookieJar?: CookieJarStore;
  policy?: HostPolicy;
  secrets?: string[];
  signal?: AbortSignal;
  onEvent?: (e: RunEvent) => void;
  /** Max bytes of response body kept per result (default 16 KB). */
  keepBodyBytes?: number;
  /** Keep results in the returned summary (default true). Disable when persisting via onEvent. */
  retainResults?: boolean;
  oauth2CacheScope?: string;
  scriptLimits?: Partial<ScriptLimits>;
  requestDefaults?: RequestDefaults;
  onExecution?: (item: RunItem, result: ExecuteResult) => void;
}

/** Depth-first flattening of a folder tree in sort order. */
export function flattenTree(root: FolderNode, ancestors: FolderDef[] = []): RunItem[] {
  const out: RunItem[] = [];
  const walk = (folder: FolderNode, chain: FolderDef[]) => {
    const { children, kind: _k, ...def } = folder;
    const nextChain = [...chain, def];
    for (const child of children) {
      if (child.kind === "request") {
        const { kind: _rk, ...req } = child;
        out.push({ request: req, ancestors: nextChain, path: nextChain.map((f) => f.name).join(" / ") });
      } else walk(child, nextChain);
    }
  };
  walk(root, ancestors);
  return out;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (ms <= 0 || signal?.aborted) return resolve();
    const finish = () => {
      clearTimeout(t);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const t = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });

function toResult(
  iteration: number,
  sequence: number,
  item: RunItem,
  r: ExecuteResult,
  keep: number,
): RunResult {
  const res = r.response;
  return {
    iteration,
    sequence,
    requestId: item.request.id,
    name: item.request.name,
    path: item.path,
    method: r.sent?.method ?? item.request.method,
    url: r.sent?.url ?? item.request.url,
    status: res?.status ?? null,
    statusText: res?.statusText ?? null,
    timeMs: res ? Math.round(res.timings.total) : null,
    size: res?.size ?? null,
    tests: r.tests,
    scriptErrors: r.scriptErrors,
    error: r.error ?? null,
    passed: r.skipped || executionPassed(r),
    skipped: r.skipped,
    responseBody: res && !res.isBinary ? res.bodyText.slice(0, keep) : undefined,
    responseHeaders: res?.headers,
  };
}

/**
 * Run a collection. Returns the summary and the final variable scopes
 * (callers decide whether to persist them).
 */
export async function runCollection(
  input: RunCollectionInput,
): Promise<{ summary: RunSummary; scopes: VariableScopes }> {
  const startedAt = Date.now();
  const opts = input.options;
  const allItems = flattenTree(input.root, input.ancestors);
  const resolveRequest: SavedRequestResolver =
    input.resolveRequest ??
    ((id) => {
      const item = allItems.find((item) => item.request.id === id);
      if (!item) throw new Error("Saved request not found");
      return item;
    });
  let items = allItems;
  if (input.selectedRequestIds?.length) {
    const set = new Set(input.selectedRequestIds);
    items = items.filter((i) => set.has(i.request.id));
  }
  const rows = input.data?.rows ?? [];
  const iterations = Math.max(1, rows.length && !opts.iterations ? rows.length : opts.iterations || 1);
  const emit = input.onEvent ?? (() => undefined);
  const keep = input.keepBodyBytes ?? 16 * 1024;
  const results: RunResult[] = [];
  let totalRequests = 0;
  let failedRequests = 0;
  let totalTests = 0;
  let passedTests = 0;
  let failedTests = 0;
  let scopes: VariableScopes = structuredClone(input.scopes);
  let status: RunSummary["status"] = "passed";
  let sequence = 0;
  let stopped = false;

  emit({ type: "start", name: input.root.name, iterations, total: items.length * iterations, startedAt });

  for (let iteration = 0; iteration < iterations && !stopped; iteration++) {
    // Row n becomes the data scope for iteration n (rows repeat if there are more iterations).
    const data = rows.length ? rows[iteration % rows.length] : {};
    scopes = { ...scopes, data, local: {} };
    emit({ type: "iteration", iteration, data });

    let index = 0;
    let steps = 0;
    const maxSteps = Math.max(100, items.length * 50); // guards against setNextRequest loops
    while (index < items.length && !stopped) {
      if (input.signal?.aborted) {
        status = "cancelled";
        stopped = true;
        break;
      }
      if (++steps > maxSteps) {
        emit({
          type: "log",
          entries: [
            {
              level: "error",
              source: "runner",
              message: "Stopping: too many steps (setNextRequest loop?)",
              timestamp: Date.now(),
            },
          ],
        });
        status = "failed";
        stopped = true;
        break;
      }
      const item = items[index];
      emit({ type: "request", iteration, sequence, name: item.request.name });
      const r = await execute({
        request: item.request,
        resolveRequest,
        ancestors: item.ancestors,
        scopes,
        cookieJar: input.cookieJar,
        policy: input.policy,
        secrets: input.secrets,
        iteration,
        iterationCount: iterations,
        signal: input.signal,
        overrides: { timeoutMs: opts.timeoutMs, verifySsl: opts.verifySsl },
        oauth2CacheScope: input.oauth2CacheScope,
        scriptLimits: input.scriptLimits,
        requestDefaults: input.requestDefaults,
      });
      input.onExecution?.(item, r);
      scopes = r.scopes;
      if (r.logs.length) emit({ type: "log", entries: r.logs });
      const rawResult = toResult(iteration, sequence++, item, r, keep);
      rawResult.executionDetails = recordExecution(
        r,
        input.secrets ?? [],
        undefined,
        item.request.body.mode === "binary" || item.request.body.mode === "formdata",
      );
      if (rawResult.executionDetails.response?.body.text !== undefined)
        rawResult.responseBody = rawResult.executionDetails.response.body.text.slice(0, keep);
      const result = { ...redactStoredValue(rawResult, input.secrets ?? []), requestId: rawResult.requestId };
      if (input.retainResults !== false) results.push(result);
      totalRequests++;
      if (!result.passed) failedRequests++;
      for (const test of result.tests) {
        if (test.skipped) continue;
        totalTests++;
        if (test.passed) passedTests++;
        else failedTests++;
      }
      emit({ type: "result", result });

      if (!result.passed) {
        if (status === "passed") status = "failed";
        if (opts.stopOnFailure) {
          stopped = true;
          break;
        }
      }
      if (input.signal?.aborted) {
        status = "cancelled";
        stopped = true;
        break;
      }

      // Flow control via pm.execution.setNextRequest().
      if (r.nextRequestSet) {
        if (r.nextRequest === null) {
          stopped = true;
          break;
        }
        const target = items.findIndex(
          (i) => i.request.name === r.nextRequest || i.request.id === r.nextRequest,
        );
        index = target >= 0 ? target : items.length;
      } else index++;

      if (opts.delayMs > 0 && index < items.length) await sleep(opts.delayMs, input.signal);
    }
    if (opts.delayMs > 0 && iteration < iterations - 1 && !stopped) await sleep(opts.delayMs, input.signal);
  }

  const finishedAt = Date.now();
  const summary: RunSummary = {
    name: input.root.name,
    status,
    iterations,
    totalRequests,
    failedRequests,
    totalTests,
    passedTests,
    failedTests,
    durationMs: finishedAt - startedAt,
    startedAt,
    finishedAt,
    results,
  };
  const { results: _r, ...rest } = summary;
  emit({ type: "done", summary: rest });
  return { summary, scopes };
}
