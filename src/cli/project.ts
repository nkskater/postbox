import { basename, resolve } from "node:path";
import type { Command } from "commander";
import { checkProject } from "../core/project/doctor";
import { scaffoldProject } from "../core/project/scaffold";
import {
  SkillError,
  installedSkills,
  installSkills,
  resolveSkills,
  skillStatus,
  SKILLS,
  type SkillChange,
} from "../core/project/skills";
import { CliError, EXIT } from "./errors";
import { renderTable } from "./output";

const print = (value: unknown): void => {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
};

async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof SkillError)
      throw new CliError(error.message, error.kind === "usage" ? EXIT.usage : EXIT.invalid);
    throw error;
  }
}

function httpUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") return value.replace(/\/+$/, "");
  } catch {
    // reported below
  }
  throw new CliError(`--base-url must be an http(s) URL: ${value}`, EXIT.usage);
}

const CHANGE_LABELS: Record<SkillChange["action"], string> = {
  created: "created",
  updated: "updated",
  unchanged: "unchanged",
  "kept-edited": "kept (edited locally)",
  "kept-untracked": "kept (not installed by Postbox)",
  removed: "removed",
  "kept-removed": "kept (edited; no longer shipped)",
};

function reportChanges(changes: SkillChange[], json: boolean | undefined, dryRun: boolean | undefined) {
  if (json) return print({ dryRun: Boolean(dryRun), changes });
  for (const change of changes)
    console.log(`${CHANGE_LABELS[change.action].padEnd(34)} ${change.skill}/${change.path}`);
  if (changes.some((change) => change.action.startsWith("kept-")))
    console.log("Edited files were kept. Pass --force to replace them with the shipped version.");
  if (dryRun) console.log("Dry run: nothing was written.");
}

export function registerProject(program: Command) {
  program
    .command("init")
    .description(
      "Create a Postbox project (config, sample collection and environment) without overwriting files",
    )
    .argument("[dir]", "Project directory", ".")
    .option("--name <name>", "Project and collection name (default: the directory name)")
    .option("--base-url <url>", "baseUrl of the local environment", "http://localhost:8080")
    .option("--dry-run", "List the files without writing them")
    .option("--json", "Print JSON")
    .exitOverride()
    .action(
      async (dir: string, options: { name?: string; baseUrl: string; dryRun?: boolean; json?: boolean }) => {
        const name = (options.name ?? basename(resolve(dir))).trim() || "api";
        const results = await scaffoldProject(
          dir,
          { name, baseUrl: httpUrl(options.baseUrl) },
          { dryRun: options.dryRun },
        );
        if (options.json) return print({ dir, dryRun: Boolean(options.dryRun), files: results });
        for (const result of results)
          console.log(
            `${(result.action === "kept" ? "kept (exists)" : options.dryRun ? "would create" : "created").padEnd(14)} ${result.path}`,
          );
        if (options.dryRun) return;
        console.log(
          `\nNext: postbox doctor${dir === "." ? "" : ` ${dir}`}, then postbox run <collection> -e <environment>.`,
        );
      },
    );

  program
    .command("doctor")
    .alias("status")
    .description("Check a Postbox project: config, collections, environment, Git and installed skills")
    .argument("[dir]", "Project directory", ".")
    .option("--json", "Print JSON")
    .exitOverride()
    .action(async (dir: string, options: { json?: boolean }) => {
      const report = await checkProject(dir);
      if (options.json) print(report);
      else {
        const width = Math.max(...report.checks.map((check) => check.id.length));
        for (const check of report.checks)
          console.log(`${check.status.toUpperCase().padEnd(4)}  ${check.id.padEnd(width)}  ${check.message}`);
      }
      if (!report.ok) process.exitCode = EXIT.invalid;
    });

  const skills = program
    .command("skills")
    .description(
      "Install and update the agent skills shipped with Postbox (only into a directory you choose)",
    )
    .exitOverride();

  skills
    .command("list")
    .description("List available skills and, with --dir, their installed state")
    .option("--dir <path>", "Skills directory to compare against")
    .option("--json", "Print JSON")
    .exitOverride()
    .action((options: { dir?: string; json?: boolean }) =>
      guard(async () => {
        const rows = options.dir
          ? await skillStatus(options.dir)
          : SKILLS.map((skill) => ({
              name: skill.name,
              version: skill.version,
              description: skill.description,
            }));
        if (options.json) return print(rows);
        const columns = [
          { header: "NAME", get: (row: Record<string, unknown>) => row.name },
          { header: "VERSION", get: (row: Record<string, unknown>) => row.version },
          ...(options.dir
            ? [
                { header: "INSTALLED", get: (row: Record<string, unknown>) => row.installed ?? "" },
                { header: "STATE", get: (row: Record<string, unknown>) => row.state },
              ]
            : [{ header: "DESCRIPTION", get: (row: Record<string, unknown>) => row.description }]),
        ];
        console.log(renderTable(rows as unknown as Record<string, unknown>[], columns));
      }),
    );

  const writeOptions = (command: Command) =>
    command
      .requiredOption("--dir <path>", "Skills directory, e.g. .agents/skills (created if missing)")
      .option("--force", "Replace edited files and files Postbox did not install")
      .option("--dry-run", "Show the changes without writing")
      .option("--json", "Print JSON")
      .exitOverride();

  writeOptions(
    skills
      .command("install")
      .description("Install the named skills, or all of them with --all")
      .argument("[names...]", "Skill names (see `postbox skills list`)")
      .option("--all", "Install every skill"),
  ).action(
    (
      names: string[],
      options: { dir: string; all?: boolean; force?: boolean; dryRun?: boolean; json?: boolean },
    ) =>
      guard(async () => {
        if (options.all && names.length)
          throw new CliError("Give skill names or --all, not both.", EXIT.usage);
        if (!options.all && !names.length)
          throw new CliError("Name the skills to install, or pass --all.", EXIT.usage);
        const chosen = options.all ? SKILLS : resolveSkills(names);
        reportChanges(await installSkills(options.dir, chosen, options), options.json, options.dryRun);
      }),
  );

  writeOptions(
    skills
      .command("update")
      .description("Update installed skills to the shipped versions, keeping files edited locally")
      .argument("[names...]", "Skill names (default: every installed skill)"),
  ).action((names: string[], options: { dir: string; force?: boolean; dryRun?: boolean; json?: boolean }) =>
    guard(async () => {
      const installed = await installedSkills(options.dir);
      const chosen = names.length ? resolveSkills(names) : installed;
      const missing = chosen.filter((skill) => !installed.includes(skill));
      if (missing.length)
        throw new CliError(
          `Not installed in ${options.dir}: ${missing.map((skill) => skill.name).join(", ")}. Use \`postbox skills install\`.`,
          EXIT.usage,
        );
      if (!chosen.length) {
        if (options.json) return print({ dryRun: Boolean(options.dryRun), changes: [] });
        return console.log(`No skills installed in ${options.dir}.`);
      }
      reportChanges(await installSkills(options.dir, chosen, options), options.json, options.dryRun);
    }),
  );
}
