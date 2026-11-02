#!/usr/bin/env node
import { importHar, isHar } from "../core/convert/har";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Command, InvalidArgumentError } from "commander";
import { version } from "../../package.json";
import {
  importPostmanCollection,
  importPostmanEnvironment,
  isPostmanCollection,
} from "../core/convert/postman";
import { CookieJarStore } from "../core/http/cookies";
import { HostPolicy } from "../core/http/policy";
import { formatIssue, readDataFile } from "../core/runner/data";
import { renderReport, type ReportFormat } from "../core/runner/reporters";
import { flattenTree, runCollection } from "../core/runner/runner";
import { DEFAULT_RUN_OPTIONS, type Variable } from "../core/types";
import { emptyScopes, redactSecrets, variablesToRecord } from "../core/variables/resolver";
import { CliError, EXIT } from "./errors";
import { registerSdk } from "./sdk";
import { registerAppTest } from "./app-test";
import { registerLoad } from "./load";
import { registerManagement } from "./manage";
import { consoleReporter } from "./reporter";

type Reporter = "cli" | ReportFormat;
const split = (value?: string) => (value?.trim() ? value.split(",") : []);
interface Options {
  environment?: string;
  globals?: string;
  data?: string;
  iterations?: number;
  delay: number;
  bail?: boolean;
  insecure?: boolean;
  timeout?: number;
  reporters: Reporter[];
  reporterJsonExport?: string;
  reporterJunitExport?: string;
  reporterHtmlExport?: string;
  header: [string, string][];
  allowSocket: string[];
  userAgent?: string;
  acceptHeaders: boolean;
  scriptTimeout?: number;
  scriptMemory?: number;
}

/** Repeatable `--header "Name: value"`. */
function header(value: string, previous: [string, string][] = []): [string, string][] {
  const i = value.indexOf(":");
  const name = i > 0 ? value.slice(0, i).trim() : "";
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name))
    throw new InvalidArgumentError('Expected "Name: value" with a valid header name.');
  return [...previous, [name, value.slice(i + 1).trim()]];
}

function integer(min: number) {
  return (value: string) => {
    const n = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(n) || n < min || n > 2_147_483_647) {
      throw new InvalidArgumentError(`Expected an integer between ${min} and 2147483647.`);
    }
    return n;
  };
}

function reporters(value: string): Reporter[] {
  const names = value.split(",").map((name) => name.trim());
  if (names.some((name) => !["cli", "json", "junit", "html"].includes(name))) {
    throw new InvalidArgumentError("Reporters must be a comma-separated list of cli,json,junit,html.");
  }
  return [...new Set(names)] as Reporter[];
}

async function jsonFile(file: string): Promise<unknown> {
  try {
    return JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error(`Cannot read JSON file ${file}: ${(error as Error).message}`);
  }
}

async function loadVariables(file?: string): Promise<Variable[]> {
  if (!file) return [];
  return importPostmanEnvironment((await jsonFile(file)) as Parameters<typeof importPostmanEnvironment>[0])
    .variables;
}

async function run(file: string, options: Options) {
  const destinations = {
    json: options.reporterJsonExport,
    junit: options.reporterJunitExport,
    html: options.reporterHtmlExport,
  };
  for (const [format, destination] of Object.entries(destinations)) {
    if (destination && !options.reporters.includes(format as Reporter)) {
      throw new Error(`Enable the ${format} reporter with --reporters to use its export option.`);
    }
  }
  const collection = await jsonFile(file);
  if (!isPostmanCollection(collection) && !isHar(collection))
    throw new Error("Expected a Postman collection or HAR 1.2 recording.");
  const imported = isPostmanCollection(collection)
    ? importPostmanCollection(collection)
    : importHar(collection);
  if ("warnings" in imported && Array.isArray(imported.warnings))
    for (const warning of imported.warnings) console.error(`postbox: warning: ${warning}`);
  const { root, variables } = imported;
  if (!flattenTree(root).length) throw new Error("Collection contains no requests.");
  const [environment, globals] = await Promise.all([
    loadVariables(options.environment),
    loadVariables(options.globals),
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
  const interrupt = () => {
    interrupted = 130;
    controller.abort();
  };
  const terminate = () => {
    interrupted = 143;
    controller.abort();
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  try {
    const { summary } = await runCollection({
      root,
      scopes: {
        ...emptyScopes(),
        collection: variablesToRecord(variables),
        environment: variablesToRecord(environment),
        globals: variablesToRecord(globals),
      },
      options: {
        ...DEFAULT_RUN_OPTIONS,
        iterations: options.iterations ?? (data?.rows.length ? 0 : 1),
        delayMs: options.delay,
        stopOnFailure: options.bail ?? false,
        timeoutMs: options.timeout,
        verifySsl: options.insecure ? false : undefined,
      },
      data,
      cookieJar: new CookieJarStore(),
      policy: new HostPolicy(split(process.env.PROXY_ALLOW_HOSTS), split(process.env.PROXY_DENY_HOSTS), [
        ...split(process.env.PROXY_ALLOW_SOCKETS),
        ...options.allowSocket,
      ]),
      secrets,
      signal: controller.signal,
      requestDefaults: {
        headers: options.header.map(([key, value]) => ({ key, value, enabled: true })),
        userAgent: options.userAgent,
        autoAcceptHeaders: options.acceptHeaders,
      },
      scriptLimits: {
        ...(options.scriptTimeout ? { timeoutMs: options.scriptTimeout } : {}),
        ...(options.scriptMemory ? { memoryBytes: options.scriptMemory * 1024 * 1024 } : {}),
      },
      retainResults: options.reporters.some((reporter) => reporter !== "cli"),
      onExecution: (_item, result) => {
        for (const [list, scope] of [
          [environment, "environment"],
          [globals, "globals"],
          [variables, "collection"],
        ] as const) {
          for (const variable of list) {
            const value = result.scopes[scope][variable.key];
            if (variable.enabled && variable.type === "secret" && value && !secrets.includes(value))
              secrets.push(value);
          }
        }
      },
      onEvent: options.reporters.includes("cli") ? consoleReporter(secrets) : undefined,
    });
    // Report bodies and assertion errors can contain values echoed by the target.
    const safeSummary = JSON.parse(
      JSON.stringify(summary, (_key, value: unknown) =>
        typeof value === "string" ? redactSecrets(value, secrets) : value,
      ),
    ) as typeof summary;
    for (const format of options.reporters) {
      if (format === "cli") continue;
      const report = renderReport(safeSummary, format);
      const destination = destinations[format] ?? `postbox-report.${report.ext}`;
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, report.body);
    }
    process.exitCode = interrupted || (summary.status === "passed" ? 0 : 1);
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  }
}

const program = new Command()
  .name("postbox")
  .description(
    "Run Postman collections locally with the Postbox engine, and manage a Postbox server's workspaces and assets.",
  )
  .version(version);

program
  .command("run")
  .description(
    "Run a Postman collection or HAR recording. Export reporters default to postbox-report.{json,xml,html}.",
  )
  .argument("<collection.json>", "Postman v2.1 collection or HAR 1.2 recording")
  .option("-e, --environment <file>", "Postman environment JSON")
  .option("-g, --globals <file>", "Postman globals JSON")
  .option("-d, --data <file>", "Iteration data (CSV, JSON, XLSX)")
  .option("-n, --iterations <count>", "Iterations (defaults to data row count, otherwise 1)", integer(1))
  .option("--delay <ms>", "Delay between requests in milliseconds", integer(0), 0)
  .option("--bail", "Stop after the first failed request or assertion")
  .option("--insecure", "Disable TLS certificate verification")
  .option("--timeout <ms>", "Request timeout in milliseconds", integer(1))
  .option(
    "--allow-socket <path>",
    "Allow requests over this Unix socket or named pipe, or dir/* (repeatable; denied by default)",
    (value: string, previous: string[]) => [...previous, value],
    [],
  )
  .option("-H, --header <header>", 'Default header for every request, "Name: value" (repeatable)', header, [])
  .option("--user-agent <value>", 'User-Agent when a request sets none ("" sends none)')
  .option("--no-accept-headers", "Do not add Accept and Accept-Encoding automatically")
  .option("--script-timeout <ms>", "Script time limit in milliseconds", integer(100))
  .option("--script-memory <mb>", "Script memory limit in MB", integer(8))
  .option("--reporters <list>", "Comma-separated reporters: cli,json,junit,html", reporters, ["cli"])
  .option("--reporter-json-export <path>", "JSON report destination")
  .option("--reporter-junit-export <path>", "JUnit XML report destination")
  .option("--reporter-html-export <path>", "HTML report destination")
  .addHelpText(
    "after",
    "\nExamples:\n  postbox run collection.json -e env.json -d data.csv\n  postbox run collection.json --bail --reporters cli,junit --reporter-junit-export reports/results.xml",
  )
  .action(run);

registerManagement(program);
registerLoad(program);
registerSdk(program);
registerAppTest(program);

await program.parseAsync().catch((error: unknown) => {
  const { code } = error as { code?: unknown; exitCode?: number };
  if (typeof code === "string" && code.startsWith("commander.")) {
    // Management groups throw instead of exiting so usage mistakes get a stable code.
    process.exitCode = ["commander.helpDisplayed", "commander.version", "commander.help"].includes(code)
      ? 0
      : EXIT.usage;
    return;
  }
  console.error(`postbox: ${(error as Error).message}`);
  process.exitCode = error instanceof CliError ? error.code : 1;
});
