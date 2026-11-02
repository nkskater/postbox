import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import type { Command } from "commander";
import YAML from "yaml";
import {
  DEFAULT_GOVERNANCE,
  governanceConfig,
  GOVERNANCE_LIMITS,
  type GovernanceReport,
} from "../core/governance/model";
import { lintGovernance } from "../core/governance/lint";
import {
  specificationFormat,
  specificationSource,
  SPEC_LIMITS,
  type SpecificationFormat,
  type SpecificationSource,
} from "../core/specifications/model";
import { CliError, EXIT } from "./errors";
async function textFile(file: string, limit: number) {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > limit)
      throw new CliError(`Input must be a file of at most ${limit} bytes`, EXIT.invalid);
    return await readFile(file, "utf8");
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(`Cannot read ${file}`, EXIT.notFound);
  }
}
export function governanceExitCode(report: GovernanceReport, failOn: "error" | "warning" | "info") {
  if (!report.complete) return EXIT.limited;
  const summary = report.summary;
  return summary.errors || (failOn !== "error" && summary.warnings) || (failOn === "info" && summary.info)
    ? EXIT.failure
    : 0;
}
export function governanceTextReport(report: GovernanceReport) {
  return [
    ...report.diagnostics.map(
      (d) => `${d.file}:${d.line}:${d.column} ${d.severity} ${d.ruleId}: ${d.message} (${d.path || "/"})`,
    ),
    `${report.complete ? "Complete" : "Incomplete"}: ${report.summary.errors} errors, ${report.summary.warnings} warnings, ${report.summary.info} info; ${report.summary.evaluated} evaluated, ${report.summary.excluded} excluded.`,
  ].join("\n");
}
export function registerGovernance(program: Command) {
  const group = program
    .command("governance")
    .description("Lint API specifications against bounded, versioned declarative governance rules.")
    .exitOverride();
  group
    .command("defaults")
    .description("Print the default governance rule set as JSON.")
    .action(() => console.log(JSON.stringify(DEFAULT_GOVERNANCE, null, 2)));
  group
    .command("lint")
    .description("Lint a local definition or exported source bundle without network access.")
    .argument("<definition>")
    .option("--rules <file>", "Governance rule-set JSON/YAML; defaults to built-in style/security rules")
    .option("--format <format>", "Source format: openapi, asyncapi, graphql, protobuf or smithy")
    .option("--include <files...>", "Explicit supporting files, relative to the entrypoint directory")
    .option("--fail-on <severity>", "Failure threshold: error, warning or info", "error")
    .option("--json", "Print the deterministic JSON report")
    .option("--report <file>", "Write the JSON report to a new file")
    .option("--overwrite", "Allow replacing the explicit report output file")
    .exitOverride()
    .action(
      async (
        file: string,
        options: {
          rules?: string;
          format?: string;
          include?: string[];
          failOn: string;
          json?: boolean;
          report?: string;
          overwrite?: boolean;
        },
        command: Command,
      ) => {
        if (!["error", "warning", "info"].includes(options.failOn))
          throw new CliError("--fail-on must be error, warning or info", EXIT.usage);
        const text = await textFile(file, SPEC_LIMITS.totalBytes * 2);
        let source: SpecificationSource,
          config = DEFAULT_GOVERNANCE;
        try {
          if (options.rules) {
            const raw = YAML.parseDocument(await textFile(options.rules, GOVERNANCE_LIMITS.bytes), {
              uniqueKeys: true,
            });
            if (raw.errors.length) throw Error("Invalid governance rule-set syntax");
            config = governanceConfig.parse(raw.toJS({ maxAliasCount: 0 }));
          }
          let bundle: unknown;
          try {
            bundle = JSON.parse(text);
          } catch {}
          if (bundle && typeof bundle === "object" && "files" in bundle) {
            if (options.include?.length || options.format)
              throw Error(
                "Bundle format and files are declared in the bundle; do not combine --include/--format",
              );
            source = specificationSource.parse(bundle);
          } else {
            let format: SpecificationFormat;
            if (options.format) format = specificationFormat.parse(options.format);
            else if (/\.proto$/i.test(file)) format = "protobuf";
            else if (/\.(graphql|gql)$/i.test(file)) format = "graphql";
            else if (/\.smithy$/i.test(file)) format = "smithy";
            else {
              let value: Record<string, unknown> = {};
              try {
                const doc = YAML.parseDocument(text);
                if (!doc.errors.length) value = doc.toJS({ maxAliasCount: 0 }) ?? {};
              } catch {}
              format = value.asyncapi ? "asyncapi" : value.smithy ? "smithy" : "openapi";
            }
            if ((options.include?.length ?? 0) >= SPEC_LIMITS.files)
              throw Error("At most 30 supplied source files are allowed");
            const files = [{ path: basename(file), content: text }];
            for (const include of options.include ?? []) {
              const full = resolve(dirname(resolve(file)), include);
              files.push({
                path: relative(dirname(resolve(file)), full).replaceAll("\\", "/"),
                content: await textFile(full, SPEC_LIMITS.bytes),
              });
            }
            source = specificationSource.parse({ format, entrypoint: basename(file), files });
          }
        } catch (error) {
          if (error instanceof CliError) throw error;
          throw new CliError(`Invalid governance input: ${(error as Error).message}`, EXIT.invalid);
        }
        let report: GovernanceReport;
        try {
          report = lintGovernance(source, config);
        } catch (error) {
          throw new CliError(`Cannot lint governance input: ${(error as Error).message}`, EXIT.invalid);
        }
        const json = JSON.stringify(report, null, 2);
        if (options.report)
          try {
            await writeFile(options.report, json + "\n", { flag: options.overwrite ? "w" : "wx" });
          } catch {
            throw new CliError(
              "Cannot write report; output must be a new file unless --overwrite is provided",
              EXIT.invalid,
            );
          }
        console.log(options.json || command.optsWithGlobals().json ? json : governanceTextReport(report));
        process.exitCode = governanceExitCode(report, options.failOn as "error" | "warning" | "info");
      },
    );
}
