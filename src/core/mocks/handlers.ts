/**
 * Sandboxed JavaScript handlers for mock servers.
 *
 * A handler is the body of a function `(req, state, example, ctx) => response | undefined`, run in a
 * fresh QuickJS (WASM) context for every request: no network, files, timers, modules or host objects,
 * with wall-clock, memory, stack, output, log and state limits. Nothing survives between calls except
 * the per-session `state`, which the host serialises, validates and stores. Handlers are deterministic:
 * `Math.random` is seeded from the mock, session and call count, and `Date` is a virtual clock that
 * advances one second per call, so the same request sequence always produces the same responses.
 */
import { createHash } from "node:crypto";
import { getQuickJS } from "quickjs-emscripten";
import { z } from "zod";
import { pathMatches } from "./scenarios";

export const MAX_HANDLERS = 20;
export const MAX_HANDLER_CODE = 16 * 1024;
export const MAX_STATE_KEYS = 100;
export const MAX_STATE_BYTES = 16 * 1024;
export const MAX_HANDLER_OUTPUT = 256 * 1024;
export const MAX_HANDLER_LOGS = 50;
export const DEFAULT_HANDLER_TIMEOUT_MS = 1000;
export const MAX_HANDLER_TIMEOUT_MS = 5000;
const MEMORY_BYTES = 8 * 1024 * 1024;
// Must stay well below the WASM native stack: a larger QuickJS limit lets runaway recursion overflow the host stack and corrupt the module.
const STACK_BYTES = 256 * 1024;
const VIRTUAL_EPOCH_MS = Date.UTC(2020, 0, 1);

export const handlerSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(100),
  enabled: z.boolean().default(true),
  /** Limit to a method and/or path (whole-segment :parameters). Omit to run for every request. */
  match: z
    .object({
      method: z
        .string()
        .regex(/^[A-Za-z]{1,16}$/)
        .optional(),
      path: z.string().max(500).startsWith("/").optional(),
    })
    .default({}),
  code: z.string().max(MAX_HANDLER_CODE),
});
export type MockHandler = z.infer<typeof handlerSchema>;
export const handlersSchema = z
  .array(handlerSchema)
  .max(MAX_HANDLERS)
  .refine((list) => new Set(list.map((h) => h.id)).size === list.length, "Handler ids must be unique");

/** Whether a handler runs for this request (disabled handlers never do). */
export function handlerApplies(handler: MockHandler, request: { method: string; path: string }): boolean {
  if (!handler.enabled) return false;
  const { method, path } = handler.match;
  if (method && method.toUpperCase() !== request.method.toUpperCase()) return false;
  if (path && !pathMatches(path, request.path)) return false;
  return true;
}

const KEY = /^[A-Za-z0-9_.:-]{1,64}$/;

export type StateValues = Record<string, unknown>;

/** Validate state that comes from outside (a test console, or the guest after a run). */
export function checkState(state: unknown): StateValues {
  if (!state || typeof state !== "object" || Array.isArray(state)) throw new Error("State must be an object");
  const entries = Object.entries(state as StateValues);
  if (entries.length > MAX_STATE_KEYS) throw new Error(`State is limited to ${MAX_STATE_KEYS} keys`);
  for (const [key] of entries)
    if (!KEY.test(key))
      throw new Error(`State key "${key.slice(0, 30)}" must be 1-64 letters, digits or _.:-`);
  if (JSON.stringify(state).length > MAX_STATE_BYTES)
    throw new Error(`State is limited to ${MAX_STATE_BYTES / 1024} KiB`);
  return Object.fromEntries(entries);
}

const resultSchema = z
  .object({
    status: z.number().int().min(200).max(599).optional(),
    headers: z.record(z.string().max(200), z.string().max(8192)).optional(),
    contentType: z.string().max(200).optional(),
    body: z.string().optional(),
    json: z.unknown().optional(),
  })
  .strict();
export type HandlerResult = z.infer<typeof resultSchema>;

export interface HandlerInput {
  request: {
    method: string;
    path: string;
    query: [string, string][];
    headers: Record<string, string>;
    body: string;
  };
  /** The matched saved example, or null. */
  example: {
    id: string;
    name: string;
    status: number;
    headers: Record<string, string>;
    /** UTF-8 text, or null for a binary example. */
    body: string | null;
  } | null;
  state: StateValues;
  /** 1-based number of times this handler has run in the session, including this call. */
  count: number;
  session: string;
  mockId: string;
  handlerId: string;
}

export type HandlerRun =
  | { ok: true; result: HandlerResult | null; state: StateValues; logs: string[]; ms: number }
  | { ok: false; error: string; logs: string[]; ms: number };

/** Request headers that carry credentials never reach a handler. */
const HIDDEN_REQUEST_HEADERS = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "x-postbox-mock-key",
]);
export function handlerHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of headers)
    if (!HIDDEN_REQUEST_HEADERS.has(k.toLowerCase())) out[k.toLowerCase()] = v.slice(0, 1024);
  return out;
}

const seedOf = (input: HandlerInput) =>
  createHash("sha256")
    .update(`${input.mockId}\0${input.session}\0${input.handlerId}\0${input.count}`)
    .digest()
    .readUInt32BE(0);

/** Guest program. It receives its input as one JSON string and returns one JSON string. */
const GUEST = String.raw`
(function (payload) {
  "use strict";
  var input = JSON.parse(payload);
  var logs = [];
  var MAX_LOGS = ${MAX_HANDLER_LOGS}, MAX_STATE_KEYS = ${MAX_STATE_KEYS}, MAX_STATE_BYTES = ${MAX_STATE_BYTES}, MAX_OUT = ${MAX_HANDLER_OUTPUT};
  var KEY = /^[A-Za-z0-9_.:-]{1,64}$/;

  // Deterministic randomness and clock.
  var a = input.seed >>> 0;
  Math.random = function () {
    a = (a + 0x6d2b79f5) >>> 0;
    var t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  var RealDate = Date, now = input.epoch + input.count * 1000;
  var VDate = function (a1, a2, a3, a4, a5, a6, a7) {
    if (!(this instanceof VDate)) return new RealDate(now).toString();
    switch (arguments.length) {
      case 0: return new RealDate(now);
      case 1: return new RealDate(a1);
      case 2: return new RealDate(a1, a2);
      case 3: return new RealDate(a1, a2, a3);
      case 4: return new RealDate(a1, a2, a3, a4);
      case 5: return new RealDate(a1, a2, a3, a4, a5);
      case 6: return new RealDate(a1, a2, a3, a4, a5, a6);
      default: return new RealDate(a1, a2, a3, a4, a5, a6, a7);
    }
  };
  VDate.prototype = RealDate.prototype;
  VDate.now = function () { return now; };
  VDate.parse = RealDate.parse;
  VDate.UTC = RealDate.UTC;
  globalThis.Date = VDate;

  var line = function (args) {
    var parts = [];
    for (var i = 0; i < args.length; i++) {
      var v = args[i];
      try { parts.push(typeof v === "string" ? v : JSON.stringify(v)); } catch (e) { parts.push(String(v)); }
    }
    if (logs.length < MAX_LOGS) logs.push(parts.join(" ").slice(0, 500));
  };
  globalThis.console = { log: function () { line(arguments); }, info: function () { line(arguments); },
    warn: function () { line(arguments); }, error: function () { line(arguments); }, debug: function () { line(arguments); } };

  // Session state: JSON values only, bounded.
  var store = input.state;
  var check = function () {
    var keys = Object.keys(store);
    if (keys.length > MAX_STATE_KEYS) throw new Error("state is limited to " + MAX_STATE_KEYS + " keys");
    if (JSON.stringify(store).length > MAX_STATE_BYTES) throw new Error("state is limited to " + (MAX_STATE_BYTES / 1024) + " KiB");
  };
  var state = Object.freeze({
    get: function (key, fallback) {
      return Object.prototype.hasOwnProperty.call(store, key) ? JSON.parse(JSON.stringify(store[key])) : fallback;
    },
    set: function (key, value) {
      if (typeof key !== "string" || !KEY.test(key)) throw new Error("state keys must be 1-64 letters, digits or _.:-");
      if (value === undefined) { delete store[key]; return; }
      var text = JSON.stringify(value);
      if (text === undefined) throw new Error("state values must be JSON");
      store[key] = JSON.parse(text);
      check();
    },
    delete: function (key) { delete store[key]; },
    has: function (key) { return Object.prototype.hasOwnProperty.call(store, key); },
    keys: function () { return Object.keys(store); },
    clear: function () { for (var k in store) delete store[k]; },
  });

  var query = {}, queryAll = {};
  input.request.query.forEach(function (pair) {
    if (!(pair[0] in query)) query[pair[0]] = pair[1];
    (queryAll[pair[0]] = queryAll[pair[0]] || []).push(pair[1]);
  });
  var parsed = null;
  try { parsed = input.request.body ? JSON.parse(input.request.body) : null; } catch (e) { parsed = null; }
  var req = Object.freeze({
    method: input.request.method, path: input.request.path, query: query, queryAll: queryAll,
    headers: input.request.headers, body: input.request.body, json: parsed,
  });
  var ctx = Object.freeze({ count: input.count, session: input.session });

  var fn = new Function("req", "state", "example", "ctx", input.code);
  var result = fn(req, state, input.example, ctx);
  if (result !== undefined && result !== null && (typeof result !== "object" || Array.isArray(result)))
    throw new Error("a handler must return an object like {status, headers, body, json}, or nothing");
  if (result && typeof result.then === "function") throw new Error("handlers must be synchronous");
  if (result) {
    var copy = {};
    ["status", "headers", "contentType", "body", "json"].forEach(function (k) { if (result[k] !== undefined) copy[k] = result[k]; });
    var extra = Object.keys(result).filter(function (k) { return ["status", "headers", "contentType", "body", "json"].indexOf(k) < 0; });
    if (extra.length) throw new Error("unknown response field: " + extra[0]);
    result = copy;
  }
  check();
  var out = JSON.stringify({ result: result === undefined ? null : result, state: store, logs: logs });
  if (out.length > MAX_OUT) throw new Error("the handler output is larger than " + (MAX_OUT / 1024) + " KiB");
  return out;
})
`;

let quickjs: ReturnType<typeof getQuickJS> | null = null;

/** Run one handler. Never throws: failures come back as `{ ok: false, error }`. */
export async function runHandler(
  code: string,
  input: HandlerInput,
  options: { timeoutMs?: number } = {},
): Promise<HandlerRun> {
  const started = Date.now();
  const timeoutMs = Math.min(
    MAX_HANDLER_TIMEOUT_MS,
    Math.max(10, options.timeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS),
  );
  const logs: string[] = [];
  const fail = (error: string, extra: string[] = logs): HandlerRun => ({
    ok: false,
    error,
    logs: extra,
    ms: Date.now() - started,
  });
  if (code.length > MAX_HANDLER_CODE)
    return fail(`Handler code is limited to ${MAX_HANDLER_CODE / 1024} KiB`);
  try {
    checkState(input.state);
  } catch (error) {
    return fail((error as Error).message);
  }
  const QuickJS = await (quickjs ??= getQuickJS());
  const runtime = QuickJS.newRuntime();
  const deadline = Date.now() + timeoutMs;
  runtime.setMemoryLimit(MEMORY_BYTES);
  runtime.setMaxStackSize(STACK_BYTES);
  runtime.setInterruptHandler(() => Date.now() >= deadline);
  const vm = runtime.newContext();
  try {
    const payload = JSON.stringify({
      code,
      seed: seedOf(input),
      epoch: VIRTUAL_EPOCH_MS,
      count: input.count,
      session: input.session,
      request: input.request,
      example: input.example,
      state: input.state,
    });
    const fnHandle = vm.unwrapResult(vm.evalCode(GUEST, "mock-handler-host.js"));
    const arg = vm.newString(payload);
    const call = vm.callFunction(fnHandle, vm.undefined, arg);
    arg.dispose();
    fnHandle.dispose();
    if (call.error) {
      const dumped = vm.dump(call.error) as { name?: string; message?: string } | string;
      call.error.dispose();
      const text =
        typeof dumped === "string" ? dumped : `${dumped?.name ?? "Error"}: ${dumped?.message ?? ""}`;
      if (Date.now() >= deadline || /interrupted/i.test(text))
        return fail(`The handler ran longer than ${timeoutMs} ms`);
      if (/out of memory/i.test(text)) return fail("The handler used more memory than allowed");
      if (/stack/i.test(text) && /overflow|exceeded/i.test(text))
        return fail("The handler exceeded the call stack limit");
      const message = text.replace(/^(Error|InternalError): /, "");
      // QuickJS reports some allocation failures without a message.
      if (!message || message === "failed" || message === "undefined")
        return fail("The handler failed (it may have exceeded its memory limit)");
      return fail(message);
    }
    const text = vm.getString(call.value);
    call.value.dispose();
    const parsed = JSON.parse(text) as { result: unknown; state: unknown; logs: string[] };
    const result = parsed.result === null ? null : resultSchema.parse(parsed.result);
    if (result) {
      for (const name of Object.keys(result.headers ?? {}))
        if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name))
          throw new Error(`Invalid response header name "${name}"`);
      for (const value of Object.values(result.headers ?? {}))
        if (/[\r\n\0]/.test(value)) throw new Error("Response header values cannot contain line breaks");
      if (result.body !== undefined && result.json !== undefined)
        throw new Error("Return either body or json, not both");
    }
    return { ok: true, result, state: checkState(parsed.state), logs: parsed.logs, ms: Date.now() - started };
  } catch (error) {
    if (error instanceof z.ZodError)
      return fail(
        `Invalid handler response: ${error.issues[0]?.path.join(".") || "result"} ${error.issues[0]?.message}`,
      );
    return fail((error as Error).message || "The handler failed");
  } finally {
    vm.dispose();
    runtime.dispose();
  }
}

interface Session {
  touched: number;
  state: StateValues;
  counts: Map<string, number>;
}

/** In-memory per-session handler state, bounded, with idle expiry. Sessions never share anything. */
export class HandlerState {
  private mocks = new Map<string, Map<string, Session>>();
  private locks = new Map<string, Promise<unknown>>();
  constructor(private options: { maxSessionsPerMock?: number; idleMs?: number } = {}) {}

  /** Run `work` for one session after earlier work for the same session finished. */
  serialize<T>(mockId: string, session: string, work: () => Promise<T>): Promise<T> {
    const key = `${mockId}\0${session}`;
    const previous = this.locks.get(key) ?? Promise.resolve();
    const next = previous.then(work, work);
    const tail = next.catch(() => undefined);
    this.locks.set(key, tail);
    void tail.then(() => {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    });
    return next;
  }

  private entry(mockId: string, session: string, now: number): Session {
    const max = this.options.maxSessionsPerMock ?? 200;
    const idle = this.options.idleMs ?? 60 * 60 * 1000;
    let sessions = this.mocks.get(mockId);
    if (!sessions) this.mocks.set(mockId, (sessions = new Map()));
    for (const [name, s] of sessions) if (now - s.touched > idle) sessions.delete(name);
    let entry = sessions.get(session);
    if (entry) sessions.delete(session);
    else entry = { touched: now, state: {}, counts: new Map() };
    entry.touched = now;
    sessions.set(session, entry);
    while (sessions.size > max) sessions.delete(sessions.keys().next().value!);
    return entry;
  }

  /** A copy of the session's state and the next call number for a handler. */
  begin(mockId: string, session: string, handlerId: string, now: number) {
    const e = this.entry(mockId, session, now);
    return { state: structuredClone(e.state) as StateValues, count: (e.counts.get(handlerId) ?? 0) + 1 };
  }

  commit(mockId: string, session: string, handlerId: string, count: number, state: StateValues, now: number) {
    const e = this.entry(mockId, session, now);
    e.state = state;
    e.counts.set(handlerId, count);
  }

  /** A failed run still counts as a call, so a retry does not repeat the same seed. */
  countOnly(mockId: string, session: string, handlerId: string, count: number, now: number) {
    this.entry(mockId, session, now).counts.set(handlerId, count);
  }

  inspect(mockId: string): { session: string; state: StateValues; counts: Record<string, number> }[] {
    return [...(this.mocks.get(mockId) ?? [])].map(([session, s]) => ({
      session,
      state: structuredClone(s.state) as StateValues,
      counts: Object.fromEntries(s.counts),
    }));
  }

  reset(mockId: string, session?: string): number {
    const sessions = this.mocks.get(mockId);
    if (!sessions) return 0;
    if (session === undefined) {
      const n = sessions.size;
      this.mocks.delete(mockId);
      return n;
    }
    return sessions.delete(session) ? 1 : 0;
  }
}
