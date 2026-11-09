import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import { z } from "zod";

/** The project file `postbox init` writes and `postbox doctor` checks. */
export const PROJECT_CONFIG = "postbox.json";

const relativePath = z
  .string()
  .min(1)
  .max(500)
  .refine((value) => isInsideProject(value), "must be a relative path inside the project");

export const projectConfigSchema = z
  .object({
    format: z.literal(1),
    name: z.string().trim().min(1).max(200),
    collections: z.array(relativePath).min(1).max(50),
    environment: relativePath.optional(),
    data: relativePath.optional(),
    reports: relativePath.default("reports"),
    skills: relativePath.optional(),
  })
  .strict();
export type ProjectConfig = z.infer<typeof projectConfigSchema>;

export function isInsideProject(path: string): boolean {
  if (!path || isAbsolute(path) || path.includes("\\") || path.includes("\0")) return false;
  const normal = normalize(path);
  return normal !== ".." && !normal.startsWith(`..${sep}`) && !normal.startsWith("../");
}

export interface ScaffoldOptions {
  name: string;
  baseUrl: string;
}

export interface ProjectFile {
  path: string;
  content: string;
}

const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
const slug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "api";

/** The files of a new project, always in the same order and with the same bytes for the same options. */
export function projectFiles({ name, baseUrl }: ScaffoldOptions): ProjectFile[] {
  const collection = `collections/${slug(name)}.postman_collection.json`;
  const environment = "environments/local.postman_environment.json";
  const config: ProjectConfig = {
    format: 1,
    name,
    collections: [collection],
    environment,
    reports: "reports",
  };
  return [
    { path: PROJECT_CONFIG, content: json(config) },
    {
      path: collection,
      content: json({
        info: {
          name,
          description: "Smoke tests created by `postbox init`. Replace the request with your own.",
          schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
        },
        item: [
          {
            name: "Health check",
            request: { method: "GET", url: { raw: "{{baseUrl}}/health" }, header: [] },
            event: [
              {
                listen: "test",
                script: {
                  type: "text/javascript",
                  exec: [
                    'pm.test("responds without a client or server error", () => {',
                    "  pm.expect(pm.response.code).to.be.below(400);",
                    "});",
                  ],
                },
              },
            ],
          },
        ],
      }),
    },
    {
      path: environment,
      content: json({
        name: "local",
        values: [{ key: "baseUrl", value: baseUrl, type: "default", enabled: true }],
        _postman_variable_scope: "environment",
      }),
    },
    { path: ".gitignore", content: "# Postbox run reports\nreports/\npostbox-report.*\n" },
  ];
}

export type ScaffoldAction = "created" | "kept";
export interface ScaffoldResult {
  path: string;
  action: ScaffoldAction;
}

async function exists(file: string) {
  return stat(file).then(
    () => true,
    (error: NodeJS.ErrnoException) => error.code !== "ENOENT",
  );
}

async function existingConfig(dir: string): Promise<ProjectConfig | null> {
  try {
    const parsed = projectConfigSchema.safeParse(
      JSON.parse(await readFile(join(dir, PROJECT_CONFIG), "utf8")),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Writes the project files that do not exist yet. Existing files are never
 * touched, so running it in a repository that already has sources is safe.
 * When the project already has a valid config, only files that config refers
 * to are considered, so a second run never adds a collection it does not list.
 */
export async function scaffoldProject(
  dir: string,
  options: ScaffoldOptions,
  { dryRun = false }: { dryRun?: boolean } = {},
): Promise<ScaffoldResult[]> {
  const results: ScaffoldResult[] = [];
  const config = await existingConfig(dir);
  const listed = config && new Set([...config.collections, config.environment]);
  const files = config
    ? projectFiles({ ...options, name: config.name }).filter(
        (file) => file.path === PROJECT_CONFIG || file.path === ".gitignore" || listed!.has(file.path),
      )
    : projectFiles(options);
  for (const file of files) {
    const target = join(dir, file.path);
    if (await exists(target)) {
      results.push({ path: file.path, action: "kept" });
      continue;
    }
    if (!dryRun) {
      await mkdir(dirname(target), { recursive: true });
      try {
        await writeFile(target, file.content, { flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        results.push({ path: file.path, action: "kept" });
        continue;
      }
    }
    results.push({ path: file.path, action: "created" });
  }
  return results;
}
