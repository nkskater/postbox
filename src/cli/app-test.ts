import { readFile, stat, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { spawn } from "node:child_process";
import type { Command } from "commander";
import { z } from "zod";
import {
  importPostmanCollection,
  importPostmanEnvironment,
  exportPostmanCollection,
  isPostmanCollection,
} from "../core/convert/postman";
import { isPostmanV3, postmanV3ToV21 } from "../core/convert/postman-v3";
import { importHar } from "../core/convert/har";
import {
  readCapture,
  captureAsHar,
  CAPTURE_LIMITS,
  captureSecrets,
  safeValue,
} from "../core/app-test/capture";
import { evaluateObservations, type AppCollection } from "../core/app-test/evaluate";
import { renderAppTestReport } from "../core/app-test/report";
import { CliError, EXIT } from "./errors";
const configSchema = z
  .object({
    version: z.literal(1),
    collections: z.array(z.string().min(1)).min(1).max(20),
    capture: z.string().min(1),
    environment: z.string().optional(),
    target: z.string().optional(),
    filter: z.string().optional(),
    strictCoverage: z.boolean().default(false),
  })
  .strict();
interface Options {
  config?: string;
  capture?: string;
  environment?: string;
  target?: string;
  filter?: string;
  strictCoverage?: boolean;
  format: string;
  reportFile?: string;
  draft?: string;
  captureOnly?: boolean;
  command?: string;
  commandTimeout: string;
}
async function boundedRead(file: string) {
  try {
    if ((await stat(file)).size > CAPTURE_LIMITS.bytes)
      throw new CliError("Input exceeds 10 MiB", EXIT.invalid);
    const text = await readFile(file, "utf8");
    if (Buffer.byteLength(text) > CAPTURE_LIMITS.bytes)
      throw new CliError("Input exceeds 10 MiB", EXIT.invalid);
    return text;
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(`Cannot read input: ${file}`, EXIT.notFound);
  }
}
async function save(file: string, text: string) {
  if (Buffer.byteLength(text) > 16 * 1024 * 1024) throw new CliError("Output exceeds 16 MiB", EXIT.limited);
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, text, { flag: "wx" });
  } catch {
    throw new CliError(`Cannot create output (existing files are protected): ${file}`, EXIT.invalid);
  }
}
async function commandRun(spec: string, capture: string, timeout: string) {
  let args: unknown;
  try {
    args = JSON.parse(spec);
  } catch {
    throw new CliError("--command requires a JSON array of executable and arguments", EXIT.usage);
  }
  if (
    !Array.isArray(args) ||
    !args.length ||
    args.length > 100 ||
    !args.every((a) => typeof a === "string" && a.length <= 16384) ||
    !args[0]
  )
    throw new CliError("Invalid command argv", EXIT.usage);
  const ms = Number(timeout);
  if (!Number.isInteger(ms) || ms < 100 || ms > 600000)
    throw new CliError("Command timeout must be 100..600000 ms", EXIT.usage);
  // A command must create a fresh artifact, so a failed recorder cannot validate stale traffic.
  try {
    await stat(capture);
    throw new CliError("Command capture already exists; choose a fresh capture path", EXIT.invalid);
  } catch (error) {
    if (error instanceof CliError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = await mkdtemp(join(tmpdir(), "postbox-app-capture-"));
  const rawCapture = join(temporary, "traffic.har");
  try {
    const exit = await new Promise<number>((resolvePromise, reject) => {
      const child = spawn(args[0], args.slice(1) as string[], {
        shell: false,
        stdio: "ignore",
        env: { ...process.env, POSTBOX_CAPTURE: rawCapture },
        timeout: ms,
        killSignal: "SIGKILL",
      });
      child.once("error", () =>
        reject(new CliError("Could not execute supplied UI-test command", EXIT.failure)),
      );
      child.once("exit", (code, signal) => resolvePromise(signal ? 1 : (code ?? 1)));
    });
    const entries = readCapture(await boundedRead(rawCapture));
    await save(
      capture,
      JSON.stringify(safeValue({ version: 1, entries }, captureSecrets(entries)), null, 2) + "\n",
    );
    return { exit, entries };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
async function appTest(files: string[], options: Options) {
  try {
    let base = process.cwd();
    let config: z.infer<typeof configSchema> | undefined;
    if (options.config) {
      config = configSchema.parse(JSON.parse(await boundedRead(options.config)));
      base = dirname(resolve(options.config));
    }
    const captures = options.capture
      ? resolve(options.capture)
      : config?.capture
        ? resolve(base, config.capture)
        : undefined;
    if (!captures) throw new CliError("Supply --capture or an explicit --config", EXIT.usage);
    if (!["json", "junit", "html"].includes(options.format))
      throw new CliError("Format must be json, junit or html", EXIT.usage);
    const paths = files.length
      ? files.map((f) => resolve(f))
      : (config?.collections ?? []).map((f) => resolve(base, f));
    if (!options.captureOnly && !paths.length)
      throw new CliError("Supply collection files or --capture-only", EXIT.usage);
    if (paths.length > 20) throw new CliError("At most 20 collections are supported", EXIT.invalid);
    if (options.captureOnly && !options.draft)
      throw new CliError("--capture-only requires --draft", EXIT.usage);
    const collections: AppCollection[] = [];
    for (const file of paths) {
      let value = JSON.parse(await boundedRead(file));
      if (isPostmanV3(value)) {
        const converted = postmanV3ToV21(value);
        if (converted.diagnostics.some((d) => d.level === "unsupported"))
          throw new Error("Unsupported Postman v3 features");
        value = converted.collection;
      }
      if (!isPostmanCollection(value)) throw new Error("Expected Postman collection");
      collections.push(importPostmanCollection(value));
    }
    const env = options.environment
      ? resolve(options.environment)
      : config?.environment
        ? resolve(base, config.environment)
        : undefined;
    const environment = env ? importPostmanEnvironment(JSON.parse(await boundedRead(env))).variables : [];
    const command = options.command
      ? await commandRun(options.command, captures, options.commandTimeout)
      : undefined;
    const exit = command?.exit ?? 0;
    const entries = command?.entries ?? readCapture(await boundedRead(captures));
    if (options.draft) {
      const imported = importHar(captureAsHar(entries), { now: () => 0 });
      if (imported.warnings.some((w) => w.includes("Skipped")))
        throw new Error("Capture cannot be converted completely to a draft");
      await save(options.draft, JSON.stringify(exportPostmanCollection(imported.root, []), null, 2) + "\n");
    }
    if (options.captureOnly) {
      console.log(
        JSON.stringify({
          mode: "capture-only",
          observations: entries.length,
          draft: options.draft,
          commandExit: exit,
        }),
      );
      process.exitCode = exit ? EXIT.failure : 0;
      return;
    }
    const report = await evaluateObservations(collections, entries, {
      environment,
      target: options.target ?? config?.target,
      filter: options.filter ?? config?.filter,
      strictCoverage: options.strictCoverage ?? config?.strictCoverage,
    });
    if (exit) {
      report.commandExit = exit;
      report.passed = false;
    }
    const text = renderAppTestReport(report, options.format as "json" | "junit" | "html");
    if (Buffer.byteLength(text) > 16 * 1024 * 1024) throw new CliError("Output exceeds 16 MiB", EXIT.limited);
    if (options.reportFile) await save(options.reportFile, text);
    else process.stdout.write(text);
    if (exit) console.error("postbox: supplied UI-test command failed");
    process.exitCode = report.passed ? 0 : EXIT.failure;
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(
      error instanceof z.ZodError
        ? "Invalid application-test input"
        : error instanceof SyntaxError
          ? "Invalid JSON input"
          : "Invalid application-test input; check collection, capture, environment and matching configuration",
      EXIT.invalid,
    );
  }
}
export function registerAppTest(program: Command) {
  program
    .command("app-init")
    .description("Deprecated; use app-test setup")
    .exitOverride()
    .action(() => {
      throw new CliError(
        "app-init is deprecated; use app-test setup --write-config postbox-app-test.json",
        EXIT.usage,
      );
    });
  const group = program
    .command("app-test")
    .enablePositionalOptions()
    .description(
      "Validate captured application traffic against collection assertions without replaying requests.",
    )
    .argument("[collections...]", "Postman collection files")
    .option("--config <file>", "Explicit app-test config (never auto-loaded)")
    .option("--capture <file>", "Playwright HAR 1.2 or Postbox observation JSON")
    .option("--environment <file>", "Postman environment JSON")
    .option("--target <origin>", "Match collection paths against this HTTP(S) origin")
    .option("--filter <text>", "Select operations by literal collection/name/URL substring")
    .option("--strict-coverage", "Fail on unmatched calls, missing assertions or unexercised operations")
    .option("--format <format>", "json, junit or html", "json")
    .option("--report-file <file>", "Create a redacted report; never overwrite")
    .option("--draft <file>", "Create a sanitized Postman collection draft; never overwrite")
    .option("--capture-only", "Create a draft without running assertions")
    .option(
      "--command <argv-json>",
      "Explicit opt-in UI-test command as JSON argv; POSTBOX_CAPTURE gives its output path",
    )
    .option("--command-timeout <ms>", "UI-test command timeout (max 600000)", "60000")
    .exitOverride()
    .action(appTest);
  group
    .command("setup")
    .description("Create an explicit app-test config; does not modify test runner or project files.")
    .requiredOption("--write-config <file>", "New config path")
    .option("--collection <file>", "Collection path relative to config", "collection.json")
    .option("--capture-path <file>", "Capture path relative to config", "test-results/network.har")
    .exitOverride()
    .action(async (options: { writeConfig: string; collection: string; capturePath: string }) => {
      await save(
        options.writeConfig,
        JSON.stringify(
          {
            version: 1,
            collections: [options.collection],
            capture: options.capturePath,
            strictCoverage: false,
          },
          null,
          2,
        ) + "\n",
      );
      console.log(
        `Created ${options.writeConfig}; configure your test runner to record full embedded HAR explicitly.`,
      );
    });
}
