/**
 * The private runner: leases monitor checks from a Postbox server, runs them inside the network it is
 * installed in, and reports metrics back (see docs/private-runners.md). Free of Next.js and database
 * imports; the transport is injectable for tests.
 */
import { importPostmanCollection, importPostmanEnvironment } from "../convert/postman";
import { CookieJarStore } from "../http/cookies";
import { HostPolicy } from "../http/policy";
import { monitorMetrics } from "../monitoring/model";
import { runCollection } from "../runner/runner";
import { DEFAULT_RUN_OPTIONS, type Variable } from "../types";
import { emptyScopes, variablesToRecord } from "../variables/resolver";
import type { RunnerJob, RunnerResult } from "./protocol";

export interface LocalConfig {
  /** Values the runner holds itself (never sent by the server); they override same-named variables. */
  variables: Record<string, string>;
  /** The runner's own host rules (PROXY_ALLOW_HOSTS / PROXY_DENY_HOSTS). */
  allowHosts: string[];
  denyHosts: string[];
  allowSockets?: string[];
}

/** Server-defined deny rules add to the local ones; a server-defined allow list wins over the local one. */
export function policyFor(job: RunnerJob, local: LocalConfig): HostPolicy {
  return new HostPolicy(
    job.policy.allowHosts.length ? job.policy.allowHosts : local.allowHosts,
    [...new Set([...local.denyHosts, ...job.policy.denyHosts])],
    local.allowSockets ?? [],
  );
}

const secret = (key: string, value: string): Variable =>
  ({ key, value, type: "secret", enabled: true }) as Variable;

/** Runs one job to completion and summarises it the way a server-side monitor run would be. */
export async function executeJob(
  job: RunnerJob,
  local: LocalConfig,
  signal?: AbortSignal,
): Promise<RunnerResult> {
  const startedAt = Date.now();
  const imported = importPostmanCollection(job.collection as Parameters<typeof importPostmanCollection>[0]);
  const fromServer = (value: unknown) =>
    value ? importPostmanEnvironment(value as Parameters<typeof importPostmanEnvironment>[0]).variables : [];
  const environment = [
    ...fromServer(job.environment).filter((variable) => !(variable.key in local.variables)),
    ...Object.entries(local.variables).map(([key, value]) => secret(key, value)),
  ];
  const globals = fromServer(job.globals);
  const secrets = [...imported.variables, ...environment, ...globals]
    .filter((variable) => variable.enabled && variable.type === "secret" && variable.value)
    .map((variable) => variable.value);

  const controller = new AbortController();
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, job.limits.maxDurationMs);
  const forward = () => controller.abort();
  signal?.addEventListener("abort", forward, { once: true });
  try {
    const { summary } = await runCollection({
      root: imported.root,
      scopes: {
        ...emptyScopes(),
        collection: variablesToRecord(imported.variables),
        environment: variablesToRecord(environment),
        globals: variablesToRecord(globals),
      },
      options: {
        ...DEFAULT_RUN_OPTIONS,
        iterations: 1,
        delayMs: 0,
        stopOnFailure: false,
        timeoutMs: job.limits.timeoutMs,
        persistVariables: false,
      },
      cookieJar: new CookieJarStore(),
      policy: policyFor(job, local),
      secrets,
      signal: controller.signal,
    });
    return {
      status: summary.status,
      timedOut,
      startedAt: summary.startedAt || startedAt,
      finishedAt: Math.max(summary.finishedAt || Date.now(), startedAt + 1),
      metrics: monitorMetrics(summary.results),
    };
  } catch (error) {
    return {
      status: "error",
      timedOut,
      startedAt,
      finishedAt: Date.now() + 1,
      metrics: monitorMetrics([]),
      error: String((error as Error).message ?? error).slice(0, 400),
    };
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener("abort", forward);
  }
}

export interface AgentOptions {
  server: string;
  token: string;
  version: string;
  local: LocalConfig;
  pollMs?: number;
  /** Stop once the queue is empty instead of waiting for more work. */
  once?: boolean;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  log?: (message: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

/** A failure that retrying will not fix (bad token, revoked runner). */
export class AgentAuthError extends Error {}

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

export async function runAgent(options: AgentOptions): Promise<{ jobs: number }> {
  const call = options.fetch ?? fetch;
  const log = options.log ?? (() => undefined);
  const sleep = options.sleep ?? ((ms: number) => wait(ms, options.signal));
  const base = options.server.replace(/\/+$/, "");
  const request = async (path: string, body?: unknown) => {
    const response = await call(`${base}/api/runner-agent/${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 401 || response.status === 403)
      throw new AgentAuthError(
        `The server refused this runner (${response.status}). Check the token and that the runner was not revoked.`,
      );
    return response;
  };

  let jobs = 0;
  let failures = 0;
  while (!options.signal?.aborted) {
    let job: RunnerJob | null = null;
    try {
      const response = await request("lease", { version: options.version });
      if (response.status === 204) job = null;
      else if (response.ok) job = (await response.json()) as RunnerJob;
      else throw new Error(`lease failed with HTTP ${response.status}`);
      failures = 0;
    } catch (error) {
      if (error instanceof AgentAuthError) throw error;
      failures++;
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(failures, 5));
      log(`cannot reach the server (${(error as Error).message}); retrying in ${Math.round(delay / 1000)}s`);
      if (options.once && failures >= 3) throw error;
      await sleep(delay);
      continue;
    }
    if (!job) {
      if (options.once) break;
      await sleep(options.pollMs ?? 5000);
      continue;
    }
    log(`running ${job.name} (attempt ${job.attempt})`);
    const stop = new AbortController();
    const beat = setInterval(
      () => {
        request(`jobs/${encodeURIComponent(job.jobId)}/heartbeat`)
          .then(async (response) => {
            const state = (await response.json().catch(() => null)) as { ok?: boolean } | null;
            if (state && state.ok === false) {
              log(`lost the lease on ${job.name}; stopping`);
              stop.abort();
            }
          })
          .catch(() => undefined);
      },
      Math.max(1000, Math.floor(job.leaseMs / 3)),
    );
    const linked = options.signal;
    const abort = () => stop.abort();
    linked?.addEventListener("abort", abort, { once: true });
    let result: RunnerResult;
    try {
      result = await executeJob(job, options.local, stop.signal);
    } finally {
      clearInterval(beat);
      linked?.removeEventListener("abort", abort);
    }
    // Delivery is idempotent on the server, so retrying until it is acknowledged is safe.
    for (let attempt = 1; ; attempt++) {
      try {
        const response = await request(`jobs/${encodeURIComponent(job.jobId)}/result`, result);
        if (response.ok) break;
        if (response.status >= 400 && response.status < 500) {
          log(`the server rejected the result (HTTP ${response.status})`);
          break;
        }
        throw new Error(`HTTP ${response.status}`);
      } catch (error) {
        if (error instanceof AgentAuthError || attempt >= 5) throw error;
        await sleep(Math.min(30_000, 1000 * 2 ** attempt));
      }
    }
    jobs++;
  }
  return { jobs };
}
