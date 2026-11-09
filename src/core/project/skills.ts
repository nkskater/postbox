import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { assertProjectPath, isInsideProject } from "./scaffold";
import { SKILL_SOURCES, type SkillSource } from "./skill-catalog";

/** Records what `postbox skills` installed, so updates can tell edited files from shipped ones. */
export const SKILL_MANIFEST = ".postbox-skills.json";

export interface Skill {
  name: string;
  version: string;
  description: string;
  files: { path: string; content: string }[];
}

const yamlString = (value: string) => JSON.stringify(value);

function build(source: SkillSource): Skill {
  const frontMatter = [
    "---",
    `name: ${source.name}`,
    `description: ${yamlString(source.description)}`,
    "metadata:",
    `  version: ${yamlString(source.version)}`,
    "  source: postbox",
    "---",
    "",
  ].join("\n");
  return {
    name: source.name,
    version: source.version,
    description: source.description,
    files: [{ path: "SKILL.md", content: frontMatter + source.body }],
  };
}

export const SKILLS: Skill[] = SKILL_SOURCES.map(build);

const safePath = z.string().refine((value) => isInsideProject(value) && value !== ".", "Invalid skill path");
const skillName = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);

const manifestSchema = z.object({
  format: z.literal(1),
  skills: z.record(
    skillName,
    z.object({ version: z.string(), files: z.record(safePath, z.string().regex(/^[0-9a-f]{64}$/)) }),
  ),
});
export type SkillManifest = z.infer<typeof manifestSchema>;

export class SkillError extends Error {
  constructor(
    message: string,
    readonly kind: "usage" | "invalid",
  ) {
    super(message);
  }
}

export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function readManifest(dir: string): Promise<SkillManifest> {
  await assertProjectPath(dir, SKILL_MANIFEST);
  const text = await readText(join(dir, SKILL_MANIFEST));
  if (text === null) return { format: 1, skills: {} };
  try {
    return manifestSchema.parse(JSON.parse(text));
  } catch {
    throw new SkillError(`${join(dir, SKILL_MANIFEST)} is not a valid skills manifest.`, "invalid");
  }
}

function sortKeys<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

async function writeManifest(dir: string, manifest: SkillManifest) {
  const stable: SkillManifest = {
    format: 1,
    skills: sortKeys(
      Object.fromEntries(
        Object.entries(manifest.skills).map(([name, entry]) => [
          name,
          { version: entry.version, files: sortKeys(entry.files) },
        ]),
      ),
    ),
  };
  const target = join(dir, SKILL_MANIFEST);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(stable, null, 2) + "\n");
  await rename(temporary, target);
}

export type SkillState = "not-installed" | "current" | "outdated" | "edited" | "missing-files";
export interface SkillStatus {
  name: string;
  description: string;
  version: string;
  installed: string | null;
  state: SkillState;
  /** Installed files that differ from what was installed. */
  edited: string[];
  missing: string[];
}

export async function skillStatus(dir: string, manifest?: SkillManifest): Promise<SkillStatus[]> {
  const recorded = manifest ?? (await readManifest(dir));
  const statuses: SkillStatus[] = [];
  for (const skill of SKILLS) {
    const entry = recorded.skills[skill.name];
    const base = { name: skill.name, description: skill.description, version: skill.version };
    if (!entry) {
      statuses.push({ ...base, installed: null, state: "not-installed", edited: [], missing: [] });
      continue;
    }
    const edited: string[] = [];
    const missing: string[] = [];
    // Shipped files that were kept because they were not written by Postbox have no recorded hash.
    const paths = [...new Set([...Object.keys(entry.files), ...skill.files.map((file) => file.path)])].sort();
    for (const path of paths) {
      await assertProjectPath(dir, `${skill.name}/${path}`);
      const text = await readText(join(dir, skill.name, path));
      const hash = entry.files[path];
      if (text === null) {
        if (hash !== undefined) missing.push(path);
      } else if (sha256(text) !== hash) edited.push(path);
    }
    const state: SkillState = missing.length
      ? "missing-files"
      : edited.length
        ? "edited"
        : entry.version !== skill.version
          ? "outdated"
          : "current";
    statuses.push({ ...base, installed: entry.version, state, edited, missing });
  }
  return statuses;
}

export type FileAction =
  "created" | "updated" | "unchanged" | "kept-edited" | "kept-untracked" | "removed" | "kept-removed";
export interface SkillChange {
  skill: string;
  path: string;
  action: FileAction;
}

export interface InstallOptions {
  /** Replace files that were edited after installing, or that were not installed by Postbox. */
  force?: boolean;
  dryRun?: boolean;
}

export function resolveSkills(names: string[]): Skill[] {
  const unknown = names.filter((name) => !SKILLS.some((skill) => skill.name === name));
  if (unknown.length)
    throw new SkillError(
      `Unknown skill${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. Available: ${SKILLS.map((s) => s.name).join(", ")}.`,
      "usage",
    );
  return SKILLS.filter((skill) => names.includes(skill.name));
}

/**
 * Installs or updates skills in `dir/<skill>/`. A file is replaced only when it
 * still matches what Postbox installed; edited files and files Postbox did not
 * write are kept unless `force` is set. Files a newer version no longer ships
 * are removed when unedited.
 */
export async function installSkills(
  dir: string,
  skills: Skill[],
  { force = false, dryRun = false }: InstallOptions = {},
): Promise<SkillChange[]> {
  const manifest = await readManifest(dir);
  const changes: SkillChange[] = [];
  for (const skill of skills) {
    const previous = manifest.skills[skill.name];
    const files: Record<string, string> = {};
    for (const file of skill.files) {
      await assertProjectPath(dir, `${skill.name}/${file.path}`);
      const target = join(dir, skill.name, file.path);
      const current = await readText(target);
      const next = sha256(file.content);
      const recorded = previous?.files[file.path];
      let action: FileAction;
      if (current === null) action = "created";
      else if (sha256(current) === next) action = "unchanged";
      else if (force || (recorded !== undefined && sha256(current) === recorded)) action = "updated";
      else action = recorded === undefined ? "kept-untracked" : "kept-edited";
      changes.push({ skill: skill.name, path: file.path, action });
      if (action === "created" || action === "updated") {
        if (!dryRun) {
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, file.content);
        }
        files[file.path] = next;
      } else if (action === "unchanged") files[file.path] = next;
      // An edited file keeps its recorded hash, so it is still reported as edited.
      else if (action === "kept-edited") files[file.path] = recorded!;
    }
    for (const [path, recorded] of Object.entries(previous?.files ?? {})) {
      if (skill.files.some((file) => file.path === path)) continue;
      await assertProjectPath(dir, `${skill.name}/${path}`);
      const target = join(dir, skill.name, path);
      const current = await readText(target);
      if (current === null) continue;
      if (force || sha256(current) === recorded) {
        if (!dryRun) await rm(target);
        changes.push({ skill: skill.name, path, action: "removed" });
      } else {
        changes.push({ skill: skill.name, path, action: "kept-removed" });
        files[path] = recorded;
      }
    }
    manifest.skills[skill.name] = { version: skill.version, files };
  }
  if (!dryRun) {
    await mkdir(dir, { recursive: true });
    await writeManifest(dir, manifest);
  }
  return changes;
}

/** The installed skills, for `postbox skills update` without names. */
export async function installedSkills(dir: string): Promise<Skill[]> {
  const manifest = await readManifest(dir);
  return SKILLS.filter((skill) => manifest.skills[skill.name]);
}
