/**
 * Script sandbox: runs pre-request / test scripts inside a fresh QuickJS (WASM)
 * runtime with memory, stack and wall-clock limits. The guest has no access to
 * Node APIs; it can only call the host functions defined below.
 */
import {
  getQuickJS,
  shouldInterruptAfterDeadline,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
} from "quickjs-emscripten";
import type { ConsoleEntry, CookieInfo, TestResult } from "../types";
import type { VariableScopes } from "../variables/resolver";
import { redactSecrets } from "../variables/resolver";
import { generateDynamic } from "../variables/dynamic";
import { CONSOLE_LEVELS, describeIssues, sandboxStateSchema, sendRequestSpecSchema } from "../schemas";
import { BOOTSTRAP_SOURCE } from "./bootstrap";

export type ScriptEvent = "prerequest" | "test";

export interface SandboxHeader {
  key: string;
  value: string;
  disabled?: boolean;
}

/** Request as seen by scripts (Postman's shape, simplified). */
export interface SandboxRequest {
  id?: string;
  name?: string;
  url: string;
  method: string;
  headers: SandboxHeader[];
  body?: Record<string, unknown> | null;
  auth?: unknown;
}

export interface SandboxResponse {
  code: number;
  status: string;
  headers: SandboxHeader[];
  body: string;
  bodyBase64?: string;
  responseTime: number;
  responseSize: number;
  cookies?: CookieInfo[];
}

export interface ScriptInfo {
  eventName: ScriptEvent;
  iteration: number;
  iterationCount: number;
  requestName: string;
  requestId: string;
}

export interface ScriptContext {
  scopes: VariableScopes;
  request: SandboxRequest;
  response?: SandboxResponse;
  info: ScriptInfo;
  cookies?: CookieInfo[];
}

/** Request object passed to pm.sendRequest (Postman request-definition shape). */
export interface SendRequestSpec {
  url: string;
  method: string;
  header: SandboxHeader[];
  body: {
    mode?: string;
    raw?: string;
    urlencoded?: SandboxHeader[];
    formdata?: SandboxHeader[];
    graphql?: unknown;
  } | null;
}

export interface ScriptHost {
  sendRequest?: (spec: SendRequestSpec, signal?: AbortSignal) => Promise<SandboxResponse>;
  runRequest?: (
    requestId: string,
    options: { variables?: Record<string, unknown> },
    signal?: AbortSignal,
  ) => Promise<SandboxResponse | null>;
}

export interface ScriptLimits {
  timeoutMs: number;
  memoryBytes: number;
  maxHostRequests: number;
  maxTimers: number;
}

export const DEFAULT_LIMITS: ScriptLimits = {
  timeoutMs: Number(process.env.SCRIPT_TIMEOUT_MS) || 5000,
  memoryBytes: (Number(process.env.SCRIPT_MEMORY_MB) || 32) * 1024 * 1024,
  maxHostRequests: 100,
  maxTimers: 1000,
};

export interface ScriptResult {
  scopes: VariableScopes;
  request: SandboxRequest;
  tests: TestResult[];
  logs: ConsoleEntry[];
  error?: string;
  /** undefined = not set, null = stop the run, string = jump to request with that name */
  nextRequest?: string | null;
  nextRequestSet: boolean;
  skipRequest: boolean;
}

export interface RunScriptOptions {
  host?: ScriptHost;
  limits?: Partial<ScriptLimits>;
  /** Values redacted from console output. */
  secrets?: string[];
  /** Label used for console entries, e.g. "Collection pre-request". */
  source?: string;
}

let quickjsPromise: ReturnType<typeof getQuickJS> | null = null;
const loadQuickJS = () => (quickjsPromise ??= getQuickJS());

/** Run a single script. Never throws for script errors; they are returned in `error`. */
export async function runScript(
  code: string,
  ctx: ScriptContext,
  opts: RunScriptOptions = {},
): Promise<ScriptResult> {
  const limits = { ...DEFAULT_LIMITS, ...opts.limits };
  const source = opts.source ?? ctx.info.eventName;
  const logs: ConsoleEntry[] = [];
  const secrets = opts.secrets ?? [];
  const base: ScriptResult = {
    scopes: ctx.scopes,
    request: ctx.request,
    tests: [],
    logs,
    nextRequestSet: false,
    skipRequest: false,
  };
  if (!code.trim()) return base;
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < (key === "maxHostRequests" || key === "maxTimers" ? 0 : 1)) {
      return { ...base, error: `Invalid script limit: ${key}` };
    }
  }
  limits.maxHostRequests = Math.min(limits.maxHostRequests, DEFAULT_LIMITS.maxHostRequests);
  limits.maxTimers = Math.min(limits.maxTimers, DEFAULT_LIMITS.maxTimers);

  const QuickJS = await loadQuickJS();
  const runtime = QuickJS.newRuntime();
  const deadline = Date.now() + limits.timeoutMs;
  runtime.setMemoryLimit(limits.memoryBytes);
  runtime.setMaxStackSize(1024 * 1024);
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(deadline));
  const vm = runtime.newContext();

  let disposed = false;
  let evaluation: QuickJSHandle | undefined;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const controller = new AbortController();
  let hostRequests = 0;
  let timerCalls = 0;
  const deferreds = new Set<QuickJSDeferredPromise>();
  const pump = () => {
    if (disposed) return;
    const r = runtime.executePendingJobs();
    if (r.error) r.error.dispose();
  };

  const define = (name: string, fn: (...args: QuickJSHandle[]) => QuickJSHandle | void) => {
    const h = vm.newFunction(name, fn);
    vm.setProp(vm.global, name, h);
    h.dispose();
  };

  /** Create a guest promise settled by a host promise. */
  const bridge = (work: Promise<string | undefined>): QuickJSHandle => {
    const d = vm.newPromise();
    deferreds.add(d);
    work.then(
      (value) => {
        if (disposed) return;
        const h = value === undefined ? vm.undefined : vm.newString(value);
        d.resolve(h);
        if (value !== undefined) h.dispose();
        deferreds.delete(d);
        d.dispose();
        pump();
      },
      (err) => {
        if (disposed) return;
        const e = vm.newError({ name: "Error", message: (err as Error)?.message ?? String(err) });
        d.reject(e);
        e.dispose();
        deferreds.delete(d);
        d.dispose();
        pump();
      },
    );
    return d.handle;
  };

  try {
    define("__host_log", (levelH, msgH) => {
      const raw = vm.getString(levelH);
      const level: ConsoleEntry["level"] = (CONSOLE_LEVELS as readonly string[]).includes(raw)
        ? (raw as ConsoleEntry["level"])
        : "log";
      const message = redactSecrets(vm.getString(msgH), secrets);
      if (logs.length < 1000) logs.push({ level, message, source, timestamp: Date.now() });
    });
    define("__host_dynamic", (nameH) => {
      const v = generateDynamic(vm.getString(nameH));
      return v === undefined ? vm.undefined : vm.newString(v);
    });
    define("__host_sleep", (msH) => {
      if (++timerCalls > limits.maxTimers)
        throw new Error(`Script exceeded the setTimeout quota of ${limits.maxTimers}`);
      const ms = Math.min(Math.max(0, vm.getNumber(msH)), Math.max(0, deadline - Date.now()));
      return bridge(
        new Promise((resolve) => {
          const timer = setTimeout(() => {
            timers.delete(timer);
            resolve(undefined);
          }, ms);
          timers.add(timer);
        }),
      );
    });
    define("__host_send", (specH) => {
      if (++hostRequests > limits.maxHostRequests)
        throw new Error(`Script exceeded the pm.sendRequest quota of ${limits.maxHostRequests}`);
      if (!opts.host?.sendRequest)
        return bridge(Promise.reject(new Error("pm.sendRequest is not available here")));
      let parsed: ReturnType<typeof sendRequestSpecSchema.safeParse>;
      try {
        parsed = sendRequestSpecSchema.safeParse(JSON.parse(vm.getString(specH)));
      } catch {
        return bridge(Promise.reject(new Error("pm.sendRequest received a request that is not JSON")));
      }
      if (!parsed.success)
        return bridge(
          Promise.reject(new Error(`Invalid pm.sendRequest request: ${describeIssues(parsed.error)}`)),
        );
      const spec: SendRequestSpec = parsed.data;
      return bridge(opts.host.sendRequest(spec, controller.signal).then((r) => JSON.stringify(r)));
    });
    define("__host_run_request", (requestIdH, optionsH) => {
      if (++hostRequests > limits.maxHostRequests)
        throw new Error(`Script exceeded the host request quota of ${limits.maxHostRequests}`);
      if (!opts.host?.runRequest)
        return bridge(Promise.reject(new Error("pm.execution.runRequest is not available here")));
      let options: { variables?: Record<string, unknown> };
      try {
        const parsed: unknown = JSON.parse(vm.getString(optionsH));
        if (
          !parsed ||
          typeof parsed !== "object" ||
          Array.isArray(parsed) ||
          ("variables" in parsed &&
            (!parsed.variables || typeof parsed.variables !== "object" || Array.isArray(parsed.variables)))
        )
          throw new Error("options must be an object with an optional variables object");
        options = parsed as typeof options;
      } catch (error) {
        return bridge(
          Promise.reject(new Error(`Invalid pm.execution.runRequest options: ${(error as Error).message}`)),
        );
      }
      return bridge(
        opts.host
          .runRequest(vm.getString(requestIdH), options, controller.signal)
          .then((response) => JSON.stringify(response)),
      );
    });

    const ctxStr = vm.newString(
      JSON.stringify({
        scopes: ctx.scopes,
        request: ctx.request,
        response: ctx.response,
        info: ctx.info,
        cookies: ctx.cookies ?? [],
      }),
    );
    vm.setProp(vm.global, "__ctx_json", ctxStr);
    ctxStr.dispose();

    const boot = vm.evalCode(BOOTSTRAP_SOURCE, "postbox-bootstrap.js");
    if (boot.error) {
      const msg = describeError(vm, boot.error);
      boot.error.dispose();
      return { ...base, error: `Sandbox bootstrap failed: ${msg}` };
    }
    boot.value.dispose();

    // Wrap user code in an async function so top-level `await` works and errors are caught.
    const wrapped =
      "(async function () {\n" +
      code +
      "\n})().then(function () { return __drain().then(function () { return null; }); }, function (e) { return __drain().then(function () { return __errMsg(e); }); })";
    const evalResult = vm.evalCode(wrapped, "script.js");
    if (evalResult.error) {
      const msg = describeError(vm, evalResult.error);
      evalResult.error.dispose();
      return { ...base, error: msg };
    }

    evaluation = evalResult.value;
    pump();
    let error: string | undefined;
    // Poll the guest promise rather than allocating host callbacks that can survive a timeout.
    while (true) {
      const outcome = vm.getPromiseState(evaluation);
      if (outcome.type === "fulfilled") {
        if (vm.typeof(outcome.value) === "string") error = vm.getString(outcome.value);
        outcome.value.dispose();
        break;
      }
      if (outcome.type === "rejected") {
        error = describeError(vm, outcome.error);
        outcome.error.dispose();
        break;
      }
      if (Date.now() >= deadline) {
        error = `Script exceeded the time limit of ${limits.timeoutMs} ms`;
        break;
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          timers.delete(timer);
          resolve();
        }, 1);
        timers.add(timer);
      });
      pump();
    }

    // Collect state even after an error so partial tests / variable changes are kept.
    const fin = vm.evalCode("__finalize()");
    if (fin.error) {
      const msg = describeError(vm, fin.error);
      fin.error.dispose();
      return { ...base, error: error ?? msg };
    }
    let rawState: unknown;
    try {
      rawState = JSON.parse(vm.getString(fin.value));
    } catch {
      rawState = undefined;
    }
    fin.value.dispose();
    const parsed = sandboxStateSchema.safeParse(rawState);
    if (!parsed.success)
      return { ...base, error: `Script produced an invalid result: ${describeIssues(parsed.error)}` };
    const state = parsed.data;
    return {
      scopes: state.scopes,
      request: { ...ctx.request, ...state.request },
      tests: state.tests,
      logs,
      error: error ? redactSecrets(friendlyError(error, limits), secrets) : undefined,
      nextRequest: state.nextRequest,
      nextRequestSet: state.nextRequestSet,
      skipRequest: state.skip,
    };
  } catch (err) {
    return { ...base, error: `Sandbox error: ${(err as Error).message}` };
  } finally {
    disposed = true;
    controller.abort();
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    for (const d of deferreds) d.dispose();
    deferreds.clear();
    if (evaluation?.alive) evaluation.dispose();
    try {
      vm.dispose();
    } catch {
      /* a leaked handle must never crash the server */
    }
    try {
      runtime.dispose();
    } catch {
      /* always attempt runtime cleanup as well */
    }
  }
}

/** Map QuickJS internal error texts to messages users understand. */
function friendlyError(msg: string, limits: ScriptLimits): string {
  if (/InternalError: interrupted/.test(msg))
    return `Script exceeded the time limit of ${limits.timeoutMs} ms`;
  if (/out of memory/i.test(msg))
    return `Script exceeded the memory limit of ${Math.round(limits.memoryBytes / 1048576)} MB`;
  return msg;
}

function describeError(vm: QuickJSContext, handle: QuickJSHandle): string {
  try {
    const e = vm.dump(handle) as { name?: string; message?: string; stack?: string } | string;
    if (typeof e === "string") return e;
    if (e && typeof e === "object") {
      if (e.message === "interrupted") return "Script exceeded the time limit";
      if (e.name === "InternalError" && /out of memory/i.test(e.message ?? ""))
        return "Script exceeded the memory limit";
      const line = /script\.js:(\d+)/.exec(e.stack ?? "")?.[1];
      return `${e.name ?? "Error"}: ${e.message ?? ""}${line ? ` (line ${Number(line) - 1})` : ""}`;
    }
    return String(e);
  } catch {
    return "Unknown script error";
  }
}
