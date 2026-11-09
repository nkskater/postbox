import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { importHar, isHar } from "../convert/har";
import { importPostmanCollection, importPostmanEnvironment, isPostmanCollection } from "../convert/postman";
import { flattenTree } from "../runner/runner";
import { PROJECT_CONFIG, projectConfigSchema, type ProjectConfig } from "./scaffold";
import { readManifest, skillStatus } from "./skills";

export type CheckStatus = "ok" | "warn" | "fail";
export interface Check {
  id: string;
  status: CheckStatus;
  message: string;
}
export interface DoctorReport {
  dir: string;
  ok: boolean;
  checks: Check[];
}

const MIN_NODE_MAJOR = 22;

async function readJson(file: string): Promise<unknown> {
  return JSON.parse((await readFile(file, "utf8")).replace(/^﻿/, ""));
}

const problem = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === "ENOENT" ? "not found" : (error as Error).message;

async function isGitRepository(dir: string): Promise<boolean> {
  let current = resolve(dir);
  for (;;) {
    if (
      await stat(join(current, ".git")).then(
        () => true,
        () => false,
      )
    )
      return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function ignoresReports(gitignore: string, reports: string): boolean {
  const target = reports.replace(/\/+$/, "");
  return gitignore
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^\//, "").replace(/\/+$/, ""))
    .some((line) => line === target || line === `${target}/*` || line === `${target}/**`);
}

/**
 * Offline checks of a Postbox project. Checks run in a fixed order and their
 * messages do not depend on timing, so the report is stable for the same files.
 */
export async function checkProject(
  dir: string,
  { nodeVersion = process.versions.node }: { nodeVersion?: string } = {},
): Promise<DoctorReport> {
  const checks: Check[] = [];
  const add = (id: string, status: CheckStatus, message: string) => checks.push({ id, status, message });
  const finish = (): DoctorReport => ({ dir, ok: !checks.some((c) => c.status === "fail"), checks });

  const major = Number(nodeVersion.split(".")[0]);
  add(
    "node",
    major >= MIN_NODE_MAJOR ? "ok" : "fail",
    major >= MIN_NODE_MAJOR
      ? `Node.js ${nodeVersion}`
      : `Node.js ${nodeVersion} is too old; ${MIN_NODE_MAJOR} or newer is required`,
  );

  let config: ProjectConfig;
  try {
    const parsed = projectConfigSchema.safeParse(await readJson(join(dir, PROJECT_CONFIG)));
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      add("config", "fail", `${PROJECT_CONFIG}: ${issue.path.join(".") || "(root)"} ${issue.message}`);
      return finish();
    }
    config = parsed.data;
    add("config", "ok", `${PROJECT_CONFIG} (${config.name})`);
  } catch (error) {
    const reason = problem(error);
    add(
      "config",
      "fail",
      reason === "not found"
        ? `${PROJECT_CONFIG} not found; run \`postbox init\``
        : `${PROJECT_CONFIG}: ${reason}`,
    );
    return finish();
  }

  for (const path of config.collections) {
    const id = `collection:${path}`;
    try {
      const data = await readJson(join(dir, path));
      if (!isPostmanCollection(data) && !isHar(data)) {
        add(id, "fail", "not a Postman collection or HAR recording");
        continue;
      }
      const { root } = isPostmanCollection(data) ? importPostmanCollection(data) : importHar(data);
      const count = flattenTree(root).length;
      add(id, count ? "ok" : "fail", count ? `${count} request${count === 1 ? "" : "s"}` : "has no requests");
    } catch (error) {
      add(id, "fail", problem(error));
    }
  }

  if (config.environment) {
    const path = config.environment;
    try {
      const environment = importPostmanEnvironment(
        (await readJson(join(dir, path))) as Parameters<typeof importPostmanEnvironment>[0],
      );
      add(
        "environment",
        "ok",
        `${path}: ${environment.variables.length} variable${environment.variables.length === 1 ? "" : "s"}`,
      );
    } catch (error) {
      add("environment", "fail", `${path}: ${problem(error)}`);
    }
  }

  if (config.data) {
    const path = config.data;
    const found = await stat(join(dir, path)).then(
      (info) => info.isFile(),
      () => false,
    );
    add("data", found ? "ok" : "fail", found ? path : `${path}: not found`);
  }

  const gitignore = await readFile(join(dir, ".gitignore"), "utf8").catch(() => "");
  const ignored = ignoresReports(gitignore, config.reports);
  add(
    "reports",
    ignored ? "ok" : "warn",
    ignored
      ? `${config.reports}/ is ignored by Git`
      : `add ${config.reports}/ to .gitignore so run reports are not committed`,
  );

  const inGit = await isGitRepository(dir);
  add("git", inGit ? "ok" : "warn", inGit ? "inside a Git repository" : "not a Git repository");

  if (config.skills) {
    const skillsDir = join(dir, config.skills);
    try {
      const manifest = await readManifest(skillsDir);
      if (!Object.keys(manifest.skills).length) {
        add("skills", "warn", `no skills installed in ${config.skills}; see \`postbox skills list\``);
      } else {
        for (const status of await skillStatus(skillsDir, manifest)) {
          if (status.state === "not-installed") continue;
          const id = `skill:${status.name}`;
          if (status.state === "current") add(id, "ok", `${status.name} ${status.version}`);
          else if (status.state === "outdated")
            add(id, "warn", `${status.name} ${status.installed} is outdated (${status.version} available)`);
          else if (status.state === "edited")
            add(id, "warn", `${status.name} has local edits: ${status.edited.join(", ")}`);
          else add(id, "fail", `${status.name} is missing ${status.missing.join(", ")}`);
        }
      }
    } catch (error) {
      add("skills", "fail", (error as Error).message);
    }
  }
  return finish();
}
