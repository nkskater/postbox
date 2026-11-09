/**
 * A collection as a tree of plain files, built to live in Git: one JSON file per request, scripts as real
 * `.js` files, stable names and key order so unrelated edits never touch the same lines, and nothing secret.
 *
 *   collection.json              the collection (name, auth shape, headers, order of its children)
 *   collection.pre-request.js    its scripts, when it has any
 *   variables.json               collection variables (secret values blank)
 *   <slug>--<id>/folder.json     a folder, and its scripts beside it
 *   <slug>--<id>.request.json    a request, with <slug>--<id>.pre-request.js / .test.js beside it
 *
 * Pure functions over snapshots: no database, no file system, no HTTP.
 */
import { z } from "zod";
import { buildEnvironmentSnapshot, canonicalJson, type SnapNode, type Snapshot } from "../dependencies/model";
import { requestInputSchema } from "../schemas";
import { specificationFormat, specificationSource, type SpecificationSource } from "../specifications/model";
import type { Variable } from "../types";

export const REPOSITORY_FORMAT = 1;
export const REPOSITORY_LIMITS = {
  files: 5000,
  fileBytes: 2 * 1024 * 1024,
  totalBytes: 24 * 1024 * 1024,
} as const;
export type FileSet = Record<string, string>;

export class RepositoryError extends Error {
  constructor(
    message: string,
    readonly path?: string,
  ) {
    super(path ? `${path}: ${message}` : message);
  }
}

// ------------------------------------------------------------------ names

export function slugify(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug || "untitled";
}
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const baseName = (name: string, id: string) => `${slugify(name)}--${id}`;

const SCRIPT_FIELDS = [
  ["preRequestScript", "pre-request.js"],
  ["testScript", "test.js"],
] as const;

/** Stable, human-diffable JSON: sorted keys, two spaces, trailing newline. */
export function stableJson(value: unknown): string {
  return JSON.stringify(JSON.parse(canonicalJson(value)), null, 2) + "\n";
}

// ------------------------------------------------------------------ writing

/** The files that represent `snapshot`. The same snapshot always yields byte-identical files. */
export function snapshotToFiles(snapshot: Snapshot): FileSet {
  const files: FileSet = {};
  const put = (path: string, content: string) => {
    files[path] = content;
  };
  const writeNode = (node: SnapNode, dir: string, stem: string, isRoot: boolean) => {
    const data = { ...node.data };
    const scripts: [string, string][] = [];
    for (const [field, suffix] of SCRIPT_FIELDS) {
      const text = typeof data[field] === "string" ? (data[field] as string) : "";
      delete data[field];
      // Always end the file with one newline; reading removes exactly one, so scripts survive unchanged.
      if (text.trim()) scripts.push([suffix, text + "\n"]);
    }
    if (node.kind === "request") {
      put(`${dir}${stem}.request.json`, stableJson({ format: REPOSITORY_FORMAT, id: node.sid, ...data }));
      for (const [suffix, text] of scripts) put(`${dir}${stem}.${suffix}`, text);
      return;
    }
    // A folder (or the collection itself): its file lists the order of its children.
    const childStems = new Map<string, string>();
    const used = new Set<string>();
    for (const child of node.children) {
      let name = baseName(String(child.data.name ?? ""), child.sid);
      while (used.has(name)) name += "_";
      used.add(name);
      childStems.set(child.sid, name);
    }
    const own = isRoot ? "collection" : "folder";
    const folderDir = isRoot ? dir : `${dir}${stem}/`;
    put(
      `${folderDir}${own}.json`,
      stableJson({
        format: REPOSITORY_FORMAT,
        id: node.sid,
        ...data,
        order: node.children.map((c) => c.sid),
      }),
    );
    for (const [suffix, text] of scripts) put(`${folderDir}${own}.${suffix}`, text);
    for (const child of node.children) {
      const childStem = childStems.get(child.sid)!;
      writeNode(child, folderDir, childStem, false);
    }
  };
  writeNode(snapshot.root, "", "", true);
  put("variables.json", stableJson(snapshot.variables.map(({ id: _id, ...v }) => v)));
  return files;
}

// ------------------------------------------------------------------ reading

const folderFile = z
  .object({
    format: z.literal(REPOSITORY_FORMAT),
    id: z.string().regex(SAFE_ID).optional(),
    name: z.string().min(1).max(300),
    order: z.array(z.string()).default([]),
  })
  .passthrough();
const variableFile = z.array(
  z.object({
    key: z.string().min(1).max(500),
    value: z.string().default(""),
    type: z.enum(["default", "secret"]).default("default"),
    enabled: z.boolean().default(true),
  }),
);

/** File paths this format may contain; anything else in a directory is left alone. */
const REQUEST_FILE = /^(.+)\.request\.json$/;
const SCRIPT_SUFFIXES = SCRIPT_FIELDS.map(([, suffix]) => suffix);

/** Whether a path is one this format reads (so tools can skip unrelated files in a repository). */
export function isRepositoryPath(path: string): boolean {
  if (path.startsWith("source/")) return true;
  const name = path.slice(path.lastIndexOf("/") + 1);
  return (
    name === "specification.json" ||
    name === "collection.json" ||
    name === "environment.json" ||
    name === "folder.json" ||
    name === "variables.json" ||
    REQUEST_FILE.test(name) ||
    SCRIPT_SUFFIXES.some((suffix) => name.endsWith(`.${suffix}`))
  );
}

export function validatePath(path: string): void {
  if (
    !path ||
    path.length > 400 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  )
    throw new RepositoryError("Unsafe file path", path);
}

export function checkFileLimits(files: FileSet): void {
  const paths = Object.keys(files);
  if (paths.length > REPOSITORY_LIMITS.files)
    throw new RepositoryError(`Too many files (limit ${REPOSITORY_LIMITS.files})`);
  let total = 0;
  for (const path of paths) {
    validatePath(path);
    const size = Buffer.byteLength(files[path]);
    if (size > REPOSITORY_LIMITS.fileBytes) throw new RepositoryError("File is too large", path);
    total += size;
  }
  if (total > REPOSITORY_LIMITS.totalBytes) throw new RepositoryError("The files are too large in total");
}

function parseJson(files: FileSet, path: string): unknown {
  try {
    return JSON.parse(files[path]);
  } catch (error) {
    throw new RepositoryError(`Not valid JSON (${(error as Error).message})`, path);
  }
}

export interface ParsedRepository {
  snapshot: Snapshot;
  /** Files that are not part of the format; they are ignored, never an error. */
  ignored: string[];
}

/**
 * Read the files back into a snapshot. Nodes without an `id` (files someone added by hand) get a
 * temporary one, so they are treated as new. Throws a RepositoryError naming the offending file.
 */
export function filesToSnapshot(files: FileSet): ParsedRepository {
  checkFileLimits(files);
  if (!("collection.json" in files)) throw new RepositoryError("collection.json is missing");
  const seen = new Set<string>();
  const claimed = new Set<string>();
  const claim = (path: string) => claimed.add(path);

  const scriptsFor = (prefix: string, data: Record<string, unknown>) => {
    for (const [field, suffix] of SCRIPT_FIELDS) {
      const path = `${prefix}.${suffix}`;
      if (path in files) {
        data[field] = files[path].replace(/\r?\n$/, "");
        claim(path);
      } else if (typeof data[field] !== "string") data[field] = "";
    }
  };
  const idOf = (given: string | undefined, path: string) => {
    const id = given ?? `new:${path}`;
    if (seen.has(id)) throw new RepositoryError(`Duplicate id ${id}`, path);
    seen.add(id);
    return id;
  };

  const readDir = (dir: string, ownFile: string): SnapNode => {
    const path = `${dir}${ownFile}`;
    claim(path);
    const parsed = folderFile.safeParse(parseJson(files, path));
    if (!parsed.success)
      throw new RepositoryError(parsed.error.issues[0]?.message ?? "Invalid folder file", path);
    const { format: _f, id, order, ...data } = parsed.data;
    const stemOfFile = ownFile.replace(/\.json$/, "");
    scriptsFor(`${dir}${stemOfFile}`, data);
    const sid = idOf(id, path);
    const children: SnapNode[] = [];
    // Child folders are sub-directories with a folder.json; child requests are *.request.json files.
    const prefix = dir;
    const subdirs = new Set<string>();
    const requestPaths: string[] = [];
    for (const p of Object.keys(files)) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash === -1) {
        if (REQUEST_FILE.test(rest)) requestPaths.push(p);
      } else if (rest.slice(slash + 1) === "folder.json") subdirs.add(rest.slice(0, slash));
    }
    for (const sub of [...subdirs].sort()) children.push(readDir(`${prefix}${sub}/`, "folder.json"));
    for (const reqPath of requestPaths.sort()) {
      claim(reqPath);
      const raw = parseJson(files, reqPath);
      if (!raw || typeof raw !== "object" || Array.isArray(raw))
        throw new RepositoryError("A request file must contain an object", reqPath);
      const { format, id: rid, ...rest } = raw as Record<string, unknown>;
      if (format !== REPOSITORY_FORMAT)
        throw new RepositoryError(`Unsupported format ${String(format)}`, reqPath);
      if (rid !== undefined && (typeof rid !== "string" || !SAFE_ID.test(rid)))
        throw new RepositoryError("Invalid id", reqPath);
      const checked = requestInputSchema.safeParse(rest);
      if (!checked.success)
        throw new RepositoryError(checked.error.issues[0]?.message ?? "Invalid request", reqPath);
      if (typeof rest.name !== "string" || !rest.name)
        throw new RepositoryError("A request needs a name", reqPath);
      const stem = reqPath.slice(prefix.length).replace(REQUEST_FILE, "$1");
      const data2 = { ...rest };
      scriptsFor(`${prefix}${stem}`, data2);
      children.push({
        sid: idOf(rid as string | undefined, reqPath),
        kind: "request",
        data: data2,
        children: [],
      });
    }
    // Honour the recorded order; anything not listed (added by hand) follows, in name order.
    const position = new Map(order.map((childId, i) => [childId, i]));
    children.sort((a, b) => {
      const pa = position.get(a.sid) ?? Number.MAX_SAFE_INTEGER;
      const pb = position.get(b.sid) ?? Number.MAX_SAFE_INTEGER;
      return pa - pb || String(a.data.name).localeCompare(String(b.data.name));
    });
    return { sid, kind: "folder", data, children };
  };

  const root = readDir("", "collection.json");
  let variables: Variable[] = [];
  if ("variables.json" in files) {
    claim("variables.json");
    const parsed = variableFile.safeParse(parseJson(files, "variables.json"));
    if (!parsed.success)
      throw new RepositoryError(parsed.error.issues[0]?.message ?? "Invalid variables", "variables.json");
    variables = parsed.data;
  }
  const ignored = Object.keys(files)
    .filter((p) => !claimed.has(p))
    .sort();
  // Script files beside a node that does not exist are almost certainly a mistake worth surfacing.
  for (const p of ignored)
    if (SCRIPT_SUFFIXES.some((s) => p.endsWith(`.${s}`)))
      throw new RepositoryError("A script file has no request or folder to belong to", p);
  return {
    snapshot: { schema: 1, name: String(root.data.name ?? ""), root, variables },
    ignored,
  };
}

// ------------------------------------------------------------------ environments

/** What a set of files describes: a collection, an environment or an API specification. */
export type RepositoryKind = "collection" | "environment" | "specification";
export function repositoryKind(files: FileSet): RepositoryKind {
  const present = (["collection", "environment", "specification"] as const).filter(
    (k) => `${k}.json` in files,
  );
  if (present.length > 1)
    throw new RepositoryError(
      `${present.map((k) => `${k}.json`).join(" and ")} are both present; a directory holds one`,
    );
  if (present.length === 0)
    throw new RepositoryError("None of collection.json, environment.json or specification.json is present");
  return present[0];
}

/**
 * An environment as files: `environment.json` (id, name) and `variables.json`. Secret variables carry no
 * value, so nothing secret is written.
 */
export function environmentToFiles(snapshot: Snapshot): FileSet {
  return {
    "environment.json": stableJson({
      format: REPOSITORY_FORMAT,
      id: snapshot.root.sid,
      name: snapshot.root.data.name,
    }),
    "variables.json": stableJson(snapshot.variables.map(({ id: _id, ...v }) => v)),
  };
}

const environmentFile = z
  .object({
    format: z.literal(REPOSITORY_FORMAT),
    id: z.string().regex(SAFE_ID).optional(),
    name: z.string().min(1).max(300),
  })
  .strict();

export function filesToEnvironment(files: FileSet): ParsedRepository {
  checkFileLimits(files);
  if (!("environment.json" in files)) throw new RepositoryError("environment.json is missing");
  const parsed = environmentFile.safeParse(parseJson(files, "environment.json"));
  if (!parsed.success)
    throw new RepositoryError(
      parsed.error.issues[0]?.message ?? "Invalid environment file",
      "environment.json",
    );
  let variables: Variable[] = [];
  const claimed = new Set(["environment.json"]);
  if ("variables.json" in files) {
    claimed.add("variables.json");
    const v = variableFile.safeParse(parseJson(files, "variables.json"));
    if (!v.success)
      throw new RepositoryError(v.error.issues[0]?.message ?? "Invalid variables", "variables.json");
    variables = v.data;
  }
  const snapshot = buildEnvironmentSnapshot(
    { id: parsed.data.id ?? "new:environment.json", name: parsed.data.name },
    variables,
    true,
  );
  return {
    snapshot,
    ignored: Object.keys(files)
      .filter((p) => !claimed.has(p))
      .sort(),
  };
}

// ------------------------------------------------------------------ specifications

const SOURCE_DIR = "source/";
const specificationFile = z
  .object({
    format: z.literal(REPOSITORY_FORMAT),
    id: z.string().regex(SAFE_ID).optional(),
    name: z.string().trim().min(1).max(200),
    specification: specificationFormat,
    entrypoint: z.string().min(1).max(200),
    label: z.string().max(200).default(""),
  })
  .strict();

export interface SpecificationFiles {
  id?: string;
  name: string;
  label: string;
  source: SpecificationSource;
  ignored: string[];
}

/**
 * An API specification as files: `specification.json` (id, name, kind of spec, entrypoint, label) and the
 * source files themselves, untouched, under `source/` so they diff like any other source.
 */
export function specificationToFiles(spec: {
  id: string;
  name: string;
  label?: string;
  format: SpecificationSource["format"];
  entrypoint: string;
  files: { path: string; content: string }[];
}): FileSet {
  const out: FileSet = {
    "specification.json": stableJson({
      format: REPOSITORY_FORMAT,
      id: spec.id,
      name: spec.name,
      specification: spec.format,
      entrypoint: spec.entrypoint,
      label: spec.label ?? "",
    }),
  };
  for (const file of [...spec.files].sort((a, b) => a.path.localeCompare(b.path)))
    out[`${SOURCE_DIR}${file.path}`] = file.content;
  return out;
}

export function filesToSpecification(files: FileSet): SpecificationFiles {
  checkFileLimits(files);
  if (!("specification.json" in files)) throw new RepositoryError("specification.json is missing");
  const parsed = specificationFile.safeParse(parseJson(files, "specification.json"));
  if (!parsed.success)
    throw new RepositoryError(
      parsed.error.issues[0]?.message ?? "Invalid specification file",
      "specification.json",
    );
  const sources = Object.keys(files)
    .filter((p) => p.startsWith(SOURCE_DIR))
    .sort();
  const candidate = {
    format: parsed.data.specification,
    entrypoint: parsed.data.entrypoint,
    files: sources.map((p) => ({ path: p.slice(SOURCE_DIR.length), content: files[p] })),
  };
  const source = specificationSource.safeParse(candidate);
  if (!source.success)
    throw new RepositoryError(source.error.issues[0]?.message ?? "Invalid specification sources", "source/");
  if (!source.data.files.some((f) => f.path === source.data.entrypoint))
    throw new RepositoryError(
      `The entrypoint ${source.data.entrypoint} has no file under source/`,
      "specification.json",
    );
  return {
    id: parsed.data.id,
    name: parsed.data.name,
    label: parsed.data.label,
    source: source.data,
    ignored: Object.keys(files)
      .filter((p) => p !== "specification.json" && !p.startsWith(SOURCE_DIR))
      .sort(),
  };
}
