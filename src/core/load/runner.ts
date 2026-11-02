/**
 * Load runner: drives a collection with many virtual users (VUs) following a load profile, and aggregates
 * throughput, error and latency-percentile metrics. Each VU loops over the collection's requests with its own
 * variables and cookies, so VUs never affect each other. Pure core: persistence, quotas and admission belong
 * to the caller.
 */
import type { ModuleSnapshot } from "../packages/model";
import type { DataTable, FolderDef, FolderNode, RequestDef } from "../types";
import { execute, type SavedRequestResolver } from "../executor";
import { CookieJarStore } from "../http/cookies";
import type { HostPolicy } from "../http/policy";
import type { RequestDefaults } from "../http/prepare";
import type { ScriptLimits } from "../scripts/sandbox";
import type { VariableScopes } from "../variables/resolver";
import { flattenTree, type RunItem } from "../runner/runner";
import {
  DEFAULT_LOAD_LIMITS,
  profileDurationSec,
  targetVus,
  type LoadLimits,
  type LoadProfile,
  profileViolations,
} from "./profile";
import { LoadMetrics, bucketSecFor, type LoadSnapshot } from "./metrics";
import { evaluateThresholds, type Threshold, type ThresholdResult } from "./thresholds";

export type LoadStatus = "passed" | "failed" | "cancelled";

export interface LoadResult {
  name: string;
  status: LoadStatus;
  /** Why the test ended before its profile did, if it did. */
  stoppedBy: "cancelled" | "maxRequests" | null;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  profile: LoadProfile;
  snapshot: LoadSnapshot;
  thresholds: ThresholdResult[];
  /** Variables that were not available (e.g. {{token}}) in at least one request. */
  warnings: string[];
}

export type LoadEvent =
  | { type: "start"; name: string; profile: LoadProfile; durationSec: number; startedAt: number }
  | { type: "progress"; vus: number; snapshot: LoadSnapshot }
  | { type: "done"; result: Omit<LoadResult, "snapshot"> & { snapshot: LoadSnapshot } };

export interface LoadInput {
  root: FolderNode;
  resolveRequest?: SavedRequestResolver;
  ancestors?: FolderDef[];
  scopes: VariableScopes;
  profile: LoadProfile;
  thresholds?: readonly Threshold[];
  /** Pause between a VU's requests. */
  thinkMs?: number;
  /** One row per VU (rows repeat when there are more VUs); each VU's iteration also advances through the rows. */
  data?: DataTable | null;
  selectedRequestIds?: string[] | null;
  limits?: Partial<LoadLimits>;
  policy?: HostPolicy;
  secrets?: string[];
  signal?: AbortSignal;
  timeoutMs?: number;
  verifySsl?: boolean;
  oauth2CacheScope?: string;
  scriptLimits?: Partial<ScriptLimits>;
  scriptModules?: ModuleSnapshot;
  requestDefaults?: RequestDefaults;
  onEvent?: (event: LoadEvent) => void;
  /** How often progress is reported, in ms (default 1000). */
  progressMs?: number;
}

const TICK_MS = 100;
/** How long in-flight requests get to finish once the profile ends before they are cut off. */
const DRAIN_MS = 3000;

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (ms <= 0 || signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });

export class LoadConfigError extends Error {}

export async function runLoad(input: LoadInput): Promise<LoadResult> {
  const limits: LoadLimits = { ...DEFAULT_LOAD_LIMITS, ...input.limits };
  const problems = profileViolations(input.profile, limits);
  if (problems.length) throw new LoadConfigError(problems.join(". "));

  const allItems = flattenTree(input.root, input.ancestors);
  const resolveRequest: SavedRequestResolver =
    input.resolveRequest ??
    ((id) => {
      const item = allItems.find((i) => i.request.id === id);
      if (!item) throw new Error("Saved request not found");
      return item;
    });
  let items: RunItem[] = allItems;
  if (input.selectedRequestIds?.length) {
    const wanted = new Set(input.selectedRequestIds);
    items = items.filter((i) => wanted.has(i.request.id));
  }
  if (!items.length) throw new LoadConfigError("There are no requests to run");

  const durationSec = profileDurationSec(input.profile);
  const metrics = new LoadMetrics(bucketSecFor(durationSec));
  const rows = input.data?.rows ?? [];
  const thinkMs = Math.max(0, input.thinkMs ?? 0);
  const startedAt = Date.now();
  const t0 = performance.now();
  const elapsedMs = () => performance.now() - t0;
  const warnings = new Set<string>();
  const emit = input.onEvent ?? (() => undefined);

  // `stop` ends the profile; `hard` cuts off requests still in flight. The caller's signal is a hard stop.
  const stop = new AbortController();
  const hard = new AbortController();
  let stoppedBy: LoadResult["stoppedBy"] = null;
  const onAbort = () => {
    stoppedBy ??= "cancelled";
    stop.abort();
    hard.abort();
  };
  input.signal?.addEventListener("abort", onAbort, { once: true });
  if (input.signal?.aborted) onAbort();

  interface Vu {
    id: number;
    retire: boolean;
    done: Promise<void>;
  }
  const running = new Set<Vu>();
  let nextId = 0;

  const startVu = () => {
    const vu: Vu = { id: nextId++, retire: false, done: Promise.resolve() };
    const jar = new CookieJarStore();
    let scopes = structuredClone(input.scopes);
    vu.done = (async () => {
      for (let iteration = 0; !vu.retire && !stop.signal.aborted; iteration++) {
        const data = rows.length ? rows[(vu.id + iteration) % rows.length] : {};
        scopes = { ...scopes, data, local: {} };
        for (const item of items) {
          if (vu.retire || stop.signal.aborted) break;
          const began = performance.now();
          const result = await execute({
            request: item.request as RequestDef,
            resolveRequest,
            ancestors: item.ancestors,
            scopes,
            cookieJar: jar,
            policy: input.policy,
            secrets: input.secrets,
            iteration,
            iterationCount: 0,
            signal: hard.signal,
            overrides: { timeoutMs: input.timeoutMs, verifySsl: input.verifySsl },
            oauth2CacheScope: input.oauth2CacheScope,
            scriptLimits: input.scriptLimits,
            scriptModules: input.scriptModules,
            requestDefaults: input.requestDefaults,
          });
          scopes = result.scopes;
          // Requests cut off by our own shutdown say nothing about the target.
          if (hard.signal.aborted && result.error && /cancel/i.test(result.error)) break;
          for (const name of result.unresolved)
            if (warnings.size < 20) warnings.add(`Unresolved variable {{${name}}}`);
          const executed = !result.skipped;
          if (executed) {
            const response = result.response;
            const checks = result.tests.filter((t) => !t.skipped);
            metrics.record({
              at: elapsedMs(),
              name: item.request.name,
              latencyMs: response ? response.timings.total : performance.now() - began,
              status: response?.status ?? null,
              error: result.error ?? null,
              bytes: response?.size ?? 0,
              checksPassed: checks.filter((t) => t.passed).length,
              checksFailed: checks.filter((t) => !t.passed).length,
            });
            if (metrics.total >= limits.maxRequests) {
              stoppedBy ??= "maxRequests";
              stop.abort();
            }
          }
          if (thinkMs) await sleep(thinkMs, stop.signal);
        }
      }
    })()
      .catch(() => undefined)
      .finally(() => running.delete(vu));
    running.add(vu);
  };

  emit({ type: "start", name: input.root.name, profile: input.profile, durationSec, startedAt });

  const progressMs = input.progressMs ?? 1000;
  let lastProgress = 0;
  const live = () => [...running].filter((v) => !v.retire).length;
  try {
    while (!stop.signal.aborted) {
      const t = elapsedMs() / 1000;
      if (t >= durationSec) break;
      const target = Math.min(targetVus(input.profile, t), limits.maxVus);
      let active = live();
      while (active < target) {
        startVu();
        active++;
      }
      // Retire the newest VUs first; they finish their current request, so ramp-down never kills requests.
      for (const vu of [...running].reverse()) {
        if (active <= target) break;
        if (!vu.retire) {
          vu.retire = true;
          active--;
        }
      }
      metrics.setVus(live());
      if (elapsedMs() - lastProgress >= progressMs) {
        lastProgress = elapsedMs();
        emit({ type: "progress", vus: live(), snapshot: metrics.snapshot(t) });
      }
      await sleep(TICK_MS, stop.signal);
    }
  } finally {
    stop.abort();
    for (const vu of running) vu.retire = true;
    const drain = setTimeout(() => hard.abort(), DRAIN_MS);
    await Promise.all([...running].map((vu) => vu.done));
    clearTimeout(drain);
    input.signal?.removeEventListener("abort", onAbort);
  }

  const finishedAt = Date.now();
  const snapshot = metrics.snapshot(Math.min(elapsedMs() / 1000, durationSec));
  const thresholds = evaluateThresholds(snapshot, input.thresholds ?? []);
  const status: LoadStatus =
    stoppedBy === "cancelled" ? "cancelled" : thresholds.every((t) => t.passed) ? "passed" : "failed";
  const result: LoadResult = {
    name: input.root.name,
    status,
    stoppedBy,
    startedAt,
    finishedAt,
    durationMs: finishedAt - startedAt,
    profile: input.profile,
    snapshot,
    thresholds,
    warnings: [...warnings],
  };
  emit({ type: "done", result });
  return result;
}
