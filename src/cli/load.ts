import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Command, InvalidArgumentError } from "commander";
import { importHar, isHar } from "../core/convert/har";
import {
  importPostmanCollection,
  importPostmanEnvironment,
  isPostmanCollection,
} from "../core/convert/postman";
import { HostPolicy } from "../core/http/policy";
import { describeProfile, parseDurationSec, profileSchema, type LoadProfile } from "../core/load/profile";
import type { LoadSnapshot } from "../core/load/metrics";
import { renderLoadReport, type LoadReportFormat } from "../core/load/report";
import { runLoad, type LoadResult } from "../core/load/runner";
import { parseThreshold, type Threshold } from "../core/load/thresholds";
import { formatIssue, readDataFile } from "../core/runner/data";
import { flattenTree } from "../core/runner/runner";
import type { Variable } from "../core/types";
import { emptyScopes, redactSecrets, variablesToRecord } from "../core/variables/resolver";
import { ApiClient, streamEvents } from "./client";
import { CliError, EXIT } from "./errors";
import { defaultFormat, printItem, printList, column } from "./output";
import { resolveConnection } from "./profiles";

const split = (value?: string) => (value?.trim() ? value.split(",") : []);

/** `30`, `30s`, `5m`, `1h` to seconds. */
export function parseDuration(value: string): number {
  const n = parseDurationSec(value);
  if (n === null)
    throw new InvalidArgumentError("Expected a duration like 30, 30s, 5m or 1h, up to 24 hours.");
  return n;
}
const count = (min: number) => (value: string) => {
  const n = Number(value);
  if (!/^\d+$/.test(value) || n < min || n > 100_000)
    throw new InvalidArgumentError(`Expected an integer from ${min} to 100000.`);
  return n;
};
const threshold = (value: string, previous: Threshold[] = []) => {
  try {
    return [...previous, parseThreshold(value)];
  } catch (error) {
    throw new InvalidArgumentError((error as Error).message);
  }
};
const stage = (value: string, previous: { durationSec: number; target: number }[] = []) => {
  const m = /^(\d+[smh]?):(\d+)$/.exec(value);
  if (!m) throw new InvalidArgumentError("Expected duration:target, for example 30s:50.");
  return [...previous, { durationSec: parseDuration(m[1]), target: Number(m[2]) }];
};

interface LoadOptions {
  environment?: string;
  globals?: string;
  data?: string;
  vus?: number;
  duration?: number;
  stage: { durationSec: number; target: number }[];
  startVus: number;
  spikeVus?: number;
  spikeAt?: number;
  spikeFor?: number;
  think: number;
  threshold: Threshold[];
  maxVus: number;
  maxRequests: number;
  insecure?: boolean;
  timeout?: number;
  out?: string;
  format: LoadReportFormat;
  quiet?: boolean;
}

/** The profile the flags describe: stages make a ramp, a spike flag a spike, otherwise constant. */
export function profileFromOptions(
  o: Pick<LoadOptions, "vus" | "duration" | "stage" | "startVus" | "spikeVus" | "spikeAt" | "spikeFor">,
): LoadProfile {
  const parsed = o.stage.length
    ? { type: "ramp", startVus: o.startVus, stages: o.stage }
    : o.spikeVus !== undefined
      ? {
          type: "spike",
          baseVus: o.vus ?? 1,
          spikeVus: o.spikeVus,
          durationSec: o.duration ?? 60,
          spikeAtSec: o.spikeAt ?? Math.floor((o.duration ?? 60) / 3),
          spikeForSec: o.spikeFor ?? Math.max(1, Math.floor((o.duration ?? 60) / 6)),
        }
      : { type: "constant", vus: o.vus ?? 1, durationSec: o.duration ?? 30 };
  const result = profileSchema.safeParse(parsed);
  if (!result.success)
    throw new CliError(`Invalid load profile: ${result.error.issues[0]?.message}`, EXIT.usage);
  return result.data;
}

const ms = (n: number) => `${n.toFixed(n < 10 ? 2 : 0)} ms`;
const pct = (n: number) => `${(n * 100).toFixed(2)}%`;

export function summaryText(result: LoadResult): string {
  const s: LoadSnapshot = result.snapshot;
  const lines = [
    "",
    `${result.name}: ${describeProfile(result.profile)}`,
    `  requests   ${s.requests} in ${s.elapsedSec} s (${s.rps}/s), peak ${s.peakVus} VUs`,
    `  errors     ${s.errors} (${pct(s.errorRate)})${s.checksFailed ? `, ${s.checksFailed} failed checks` : ""}`,
    `  latency    avg ${ms(s.latency.avg)}  min ${ms(s.latency.min)}  p50 ${ms(s.latency.p50)}  p90 ${ms(s.latency.p90)}  p95 ${ms(s.latency.p95)}  p99 ${ms(s.latency.p99)}  max ${ms(s.latency.max)}`,
  ];
  for (const r of s.byRequest)
    lines.push(
      `    ${r.name.padEnd(28).slice(0, 28)} ${String(r.requests).padStart(7)} req  p95 ${ms(r.latency.p95).padStart(10)}  errors ${pct(r.errorRate)}`,
    );
  if (s.errorKinds.length) {
    lines.push("  top errors");
    for (const e of s.errorKinds.slice(0, 5)) lines.push(`    ${e.count}x ${e.message}`);
  }
  if (result.thresholds.length) {
    lines.push("  thresholds");
    for (const t of result.thresholds)
      lines.push(`    ${t.passed ? "PASS" : "FAIL"} ${t.label}: ${t.actual ?? "no data"}`);
  }
  for (const w of result.warnings) lines.push(`  warning: ${w}`);
  if (result.stoppedBy === "maxRequests") lines.push("  stopped early: request ceiling reached");
  lines.push(`  result     ${result.status}`);
  return lines.join("\n");
}

async function jsonFile(file: string): Promise<unknown> {
  try {
    return JSON.parse((await readFile(file, "utf8")).replace(/^﻿/, ""));
  } catch (error) {
    throw new CliError(`Cannot read JSON file ${file}: ${(error as Error).message}`, EXIT.usage);
  }
}

async function variablesOf(file?: string): Promise<Variable[]> {
  if (!file) return [];
  return importPostmanEnvironment((await jsonFile(file)) as Parameters<typeof importPostmanEnvironment>[0])
    .variables;
}

async function loadLocal(file: string, options: LoadOptions) {
  const profile = profileFromOptions(options);
  const collection = await jsonFile(file);
  if (!isPostmanCollection(collection) && !isHar(collection))
    throw new CliError("Expected a Postman collection or HAR 1.2 recording.", EXIT.usage);
  const imported = isPostmanCollection(collection)
    ? importPostmanCollection(collection)
    : importHar(collection);
  const { root, variables } = imported;
  if (!flattenTree(root).length) throw new CliError("Collection contains no requests.", EXIT.usage);
  const [environment, globals] = await Promise.all([
    variablesOf(options.environment),
    variablesOf(options.globals),
  ]);
  const secrets = [...variables, ...environment, ...globals]
    .filter((v) => v.enabled && v.type === "secret" && v.value)
    .map((v) => v.value);
  let data;
  if (options.data) {
    const parsed = readDataFile(options.data, await readFile(options.data));
    for (const w of parsed.warnings) console.error(`postbox: warning: ${options.data} ${formatIssue(w)}`);
    data = parsed.table;
  }
  const controller = new AbortController();
  let interrupted = 0;
  const onSignal = (code: number) => () => {
    interrupted = code;
    controller.abort();
  };
  const sigint = onSignal(130);
  const sigterm = onSignal(143);
  process.once("SIGINT", sigint);
  process.once("SIGTERM", sigterm);
  try {
    const result = await runLoad({
      root,
      scopes: {
        ...emptyScopes(),
        collection: variablesToRecord(variables),
        environment: variablesToRecord(environment),
        globals: variablesToRecord(globals),
      },
      profile,
      thresholds: options.threshold,
      thinkMs: options.think,
      data,
      limits: { maxVus: options.maxVus, maxRequests: options.maxRequests, maxDurationSec: 86_400 },
      policy: new HostPolicy(
        split(process.env.PROXY_ALLOW_HOSTS),
        split(process.env.PROXY_DENY_HOSTS),
        split(process.env.PROXY_ALLOW_SOCKETS),
      ),
      secrets,
      signal: controller.signal,
      timeoutMs: options.timeout,
      verifySsl: options.insecure ? false : undefined,
      onEvent: (e) => {
        if (e.type === "start" && !options.quiet) console.error(`postbox: ${describeProfile(e.profile)}`);
        if (e.type === "progress" && !options.quiet && process.stderr.isTTY)
          process.stderr.write(
            `\r  ${e.snapshot.elapsedSec.toFixed(0)}s  ${e.vus} VUs  ${e.snapshot.requests} req  ${e.snapshot.rps}/s  p95 ${ms(e.snapshot.latency.p95)}  errors ${pct(e.snapshot.errorRate)}   `,
          );
      },
    });
    if (process.stderr.isTTY && !options.quiet) process.stderr.write("\r\x1b[K");
    const safe = JSON.parse(
      JSON.stringify(result, (_k, v: unknown) => (typeof v === "string" ? redactSecrets(v, secrets) : v)),
    ) as LoadResult;
    console.log(summaryText(safe));
    if (options.out) {
      const report = renderLoadReport(
        {
          name: safe.name,
          status: safe.status,
          profile: safe.profile,
          startedAt: safe.startedAt,
          finishedAt: safe.finishedAt,
          stoppedBy: safe.stoppedBy,
          snapshot: safe.snapshot,
          thresholds: safe.thresholds,
          warnings: safe.warnings,
        },
        options.format,
      );
      await mkdir(dirname(options.out), { recursive: true });
      await writeFile(options.out, report.body);
      console.error(`Wrote ${options.out}`);
    }
    process.exitCode = interrupted || (safe.status === "passed" ? 0 : 1);
  } finally {
    process.removeListener("SIGINT", sigint);
    process.removeListener("SIGTERM", sigterm);
  }
}

const enc = encodeURIComponent;

export function registerLoad(program: Command) {
  program
    .command("load")
    .description(
      "Load-test a Postman collection or HAR recording with virtual users, locally. Exit code 1 when a threshold fails.",
    )
    .argument("<collection.json>", "Postman v2.1 collection or HAR 1.2 recording")
    .option("-e, --environment <file>", "Postman environment JSON")
    .option("-g, --globals <file>", "Postman globals JSON")
    .option("-d, --data <file>", "Per-user data (CSV, JSON, XLSX): each virtual user starts on its own row")
    .option("--vus <n>", "Virtual users (constant), or the base level of a spike", count(1))
    .option(
      "--duration <time>",
      "How long to run, e.g. 30s, 5m (constant and spike; default 30s)",
      parseDuration,
    )
    .option(
      "--stage <duration:target>",
      "Ramp stage such as 30s:50 (repeatable); makes the profile a ramp",
      stage,
      [],
    )
    .option("--start-vus <n>", "Virtual users a ramp starts from", count(0), 0)
    .option(
      "--spike-vus <n>",
      "Spike to this many virtual users (use with --vus, --spike-at, --spike-for)",
      count(1),
    )
    .option("--spike-at <time>", "When the spike starts", parseDuration)
    .option("--spike-for <time>", "How long the spike lasts", parseDuration)
    .option("--think <ms>", "Pause between a user's requests", count(0), 0)
    .option(
      "--threshold <expr>",
      "Fail unless it holds, e.g. p95<500, errorRate<0.01, rps>=20@Get user (repeatable)",
      threshold,
      [],
    )
    .option("--max-vus <n>", "Refuse profiles above this many virtual users", count(1), 200)
    .option("--max-requests <n>", "Stop after this many requests", count(1), 1_000_000)
    .option("--insecure", "Disable TLS certificate verification")
    .option("--timeout <ms>", "Request timeout in milliseconds", count(1))
    .option("--out <file>", "Write a report to this file")
    .option(
      "--format <format>",
      "Report format: json, csv or junit",
      (v: string) => {
        if (!["json", "csv", "junit"].includes(v)) throw new InvalidArgumentError("Use json, csv or junit.");
        return v as LoadReportFormat;
      },
      "json",
    )
    .option("-q, --quiet", "No live progress")
    .addHelpText(
      "after",
      "\nExamples:\n  postbox load api.json --vus 20 --duration 1m --threshold 'p95<400' --threshold 'errorRate<0.01'\n  postbox load api.json --stage 30s:50 --stage 2m:50 --stage 30s:0 --out report.csv --format csv\n  postbox load api.json --vus 5 --spike-vus 50 --duration 90s --spike-at 30s --spike-for 15s",
    )
    .action(loadLocal);

  const runs = program
    .command("load-run")
    .description("Start and inspect load tests on a running Postbox server");
  runs.exitOverride();
  const withServer =
    (
      action: (
        api: ApiClient,
        format: ReturnType<typeof defaultFormat>,
        args: string[],
        opts: Record<string, unknown>,
      ) => Promise<void>,
    ) =>
    async (...raw: unknown[]) => {
      const command = raw[raw.length - 1] as Command;
      const opts = command.optsWithGlobals<Record<string, unknown>>();
      const connection = await resolveConnection(opts as never);
      const args = raw.slice(0, -2).filter((v): v is string => typeof v === "string");
      await action(
        new ApiClient(connection.url, connection.token),
        (opts.output as never) ?? defaultFormat(),
        args,
        opts,
      );
    };
  runs
    .command("list")
    .description("List recent load tests")
    .option("-w, --workspace <id>", "Workspace id (or POSTBOX_WORKSPACE)")
    .action(
      withServer(async (api, format, _args, opts) => {
        const workspaceId = (opts.workspace as string) || process.env.POSTBOX_WORKSPACE;
        if (!workspaceId)
          throw new CliError("Choose a workspace with --workspace <id> or POSTBOX_WORKSPACE.", EXIT.usage);
        const rows = await api.request<Record<string, unknown>[]>("GET", "/api/load-runs", {
          query: { workspaceId },
        });
        printList(format, rows, [column("ID", "id"), column("NAME", "name"), column("STATUS", "status")], {
          offset: 0,
        });
      }),
    );
  runs
    .command("get <id>")
    .description("Show a load test with its full result")
    .action(
      withServer(async (api, format, [id]) =>
        printItem(format, await api.request("GET", `/api/load-runs/${enc(id)}`)),
      ),
    );
  runs
    .command("cancel <id>")
    .description("Stop a running or queued load test")
    .action(
      withServer(async (api, format, [id]) =>
        printItem(format, await api.request("POST", `/api/load-runs/${enc(id)}/cancel`)),
      ),
    );
  runs
    .command("export <id>")
    .description("Download a report")
    .option("--format <format>", "json, csv or junit", "json")
    .option("--out <file>", "Write to a file instead of standard output")
    .action(
      withServer(async (api, _format, [id], opts) => {
        const body = await api.request<string>("GET", `/api/load-runs/${enc(id)}/export`, {
          raw: true,
          query: { format: String(opts.format ?? "json") },
        });
        if (opts.out) await writeFile(String(opts.out), body);
        else process.stdout.write(body.endsWith("\n") ? body : body + "\n");
      }),
    );
  runs
    .command("start <folderId>")
    .description(
      "Start a load test of a collection or folder and wait for it (exit code 1 when a threshold fails)",
    )
    .option("-w, --workspace <id>", "Workspace id (or POSTBOX_WORKSPACE)")
    .option("--environment <id>", "Environment id")
    .option("--vus <n>", "Virtual users (constant, or the base of a spike)", count(1))
    .option("--duration <time>", "Duration, e.g. 30s, 5m", parseDuration)
    .option("--stage <duration:target>", "Ramp stage (repeatable)", stage, [])
    .option("--start-vus <n>", "Ramp starting level", count(0), 0)
    .option("--spike-vus <n>", "Spike level", count(1))
    .option("--spike-at <time>", "Spike start", parseDuration)
    .option("--spike-for <time>", "Spike length", parseDuration)
    .option("--think <ms>", "Pause between a user's requests", count(0), 0)
    .option("--threshold <expr>", "Threshold (repeatable)", threshold, [])
    .option("--no-wait", "Return as soon as the test has started")
    .action(
      withServer(async (api, format, [folderId], opts) => {
        const workspaceId = (opts.workspace as string) || process.env.POSTBOX_WORKSPACE;
        if (!workspaceId)
          throw new CliError("Choose a workspace with --workspace <id> or POSTBOX_WORKSPACE.", EXIT.usage);
        const profile = profileFromOptions(opts as never);
        const lines = streamEvents(api, api.token, "/api/load-runs", {
          workspaceId,
          folderId,
          profile,
          thresholds: opts.threshold,
          thinkMs: opts.think,
          ...(opts.environment ? { environmentId: opts.environment } : {}),
        });
        let runId = "";
        let status = "";
        for await (const event of lines) {
          const e = event as { type: string; runId?: string; result?: { status: string } };
          if (e.runId) runId = e.runId;
          if (e.type === "start" && opts.wait === false) break;
          if (e.type === "done") status = e.result?.status ?? "";
          if (e.type === "error") throw new CliError(String((e as { error?: string }).error), EXIT.failure);
        }
        printItem(format, { id: runId, status: status || "started" });
        if (status && status !== "passed") process.exitCode = 1;
      }),
    );
}
