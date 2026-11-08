/**
 * Offline mode: work on collections and environments that live as repository files (docs/repository-format.md)
 * in the workspace, without a server. Requests run in-process with the Postbox engine. No vscode imports.
 */
import {
  filesToEnvironment,
  filesToSnapshot,
  isRepositoryPath,
  type FileSet,
} from "../../../../src/core/repository/model";
import type { SnapNode, Snapshot } from "../../../../src/core/dependencies/model";
import { runCollection, type RunEvent } from "../../../../src/core/runner/runner";
import {
  DEFAULT_RUN_OPTIONS,
  DEFAULT_SETTINGS,
  type FolderNode,
  type RequestDef,
  type TreeNode,
  type Variable,
} from "../../../../src/core/types";
import { HostPolicy } from "../../../../src/core/http/policy";
import { CookieJarStore } from "../../../../src/core/http/cookies";
import { emptyScopes, variablesToRecord } from "../../../../src/core/variables/resolver";
import type { ViewResult } from "./types";

export interface FileAccess {
  /** Every file under `root`, as paths relative to it with `/` separators (no `.git` or `node_modules`). */
  listFiles(root: string): Promise<string[]>;
  read(path: string): Promise<string>;
}

export interface OfflineNode {
  kind: "folder" | "request";
  id: string;
  name: string;
  method?: string;
  /** Path of the request's own file, relative to the collection directory. */
  file?: string;
  children: OfflineNode[];
}
export interface OfflineCollection {
  dir: string;
  name: string;
  root: OfflineNode;
}
export interface OfflineEnvironment {
  dir: string;
  name: string;
  variables: Variable[];
}
export interface Discovered {
  collections: OfflineCollection[];
  environments: OfflineEnvironment[];
  problems: { dir: string; message: string }[];
}

const join = (dir: string, rel: string) => (dir === "" || dir === "." ? rel : `${dir}/${rel}`);
const dirname = (file: string) => (file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "");

async function readSet(access: FileAccess, root: string, dir: string, all: string[]): Promise<FileSet> {
  const prefix = dir ? `${dir}/` : "";
  const files: FileSet = {};
  const nested = all
    .filter((p) => p.endsWith("/collection.json") || p.endsWith("/environment.json"))
    .map(dirname)
    .filter((d) => d.startsWith(prefix) && d !== dir);
  for (const path of all) {
    if (!path.startsWith(prefix)) continue;
    // A nested collection directory is its own thing, not part of this one.
    if (nested.some((d) => path.startsWith(`${d}/`))) continue;
    const rel = path.slice(prefix.length);
    if (isRepositoryPath(rel)) files[rel] = await access.read(join(root, path));
  }
  return files;
}

function nodeOf(node: SnapNode, files: Map<string, string>): OfflineNode {
  return {
    kind: node.kind,
    id: node.sid,
    name: String(node.data.name ?? ""),
    method: node.kind === "request" ? String(node.data.method ?? "GET") : undefined,
    file: node.kind === "request" ? files.get(node.sid) : undefined,
    children: node.children.map((child) => nodeOf(child, files)),
  };
}

/** Finds the collection and environment directories under `root`. A broken directory is reported, not fatal. */
export async function discover(access: FileAccess, root: string): Promise<Discovered> {
  const all = (await access.listFiles(root)).slice(0, 20_000);
  const out: Discovered = { collections: [], environments: [], problems: [] };
  for (const path of all) {
    const base = path.split("/").pop();
    if (base !== "collection.json" && base !== "environment.json") continue;
    const dir = dirname(path);
    // Folder metadata inside a collection is folder.json, so any collection.json starts a collection.
    try {
      const files = await readSet(access, root, dir, all);
      if (base === "collection.json") {
        const parsed = filesToSnapshot(files).snapshot;
        const ids = new Map<string, string>();
        for (const rel of Object.keys(files)) {
          if (!rel.endsWith(".request.json")) continue;
          try {
            const id = (JSON.parse(files[rel]) as { id?: string }).id;
            if (id) ids.set(id, rel);
          } catch {
            /* reported when the collection is parsed */
          }
        }
        out.collections.push({ dir, name: parsed.name, root: nodeOf(parsed.root, ids) });
      } else {
        const parsed = filesToEnvironment(files).snapshot;
        out.environments.push({ dir, name: parsed.name, variables: parsed.variables });
      }
    } catch (error) {
      out.problems.push({ dir, message: error instanceof Error ? error.message : String(error) });
    }
  }
  out.collections.sort((a, b) => a.dir.localeCompare(b.dir));
  out.environments.sort((a, b) => a.dir.localeCompare(b.dir));
  return out;
}

function treeOf(node: SnapNode): TreeNode {
  const data = node.data as Record<string, unknown>;
  if (node.kind === "request")
    return {
      kind: "request",
      id: node.sid,
      name: "",
      method: "GET",
      url: "",
      params: [],
      headers: [],
      body: { mode: "none" },
      auth: { type: "inherit" },
      preRequestScript: "",
      testScript: "",
      description: "",
      examples: [],
      ...data,
      settings: { ...DEFAULT_SETTINGS, ...((data.settings as object | undefined) ?? {}) },
    } as unknown as RequestDef & { kind: "request" };
  return {
    kind: "folder",
    id: node.sid,
    name: "",
    description: "",
    auth: { type: "inherit" },
    headers: [],
    preRequestScript: "",
    testScript: "",
    ...data,
    children: node.children.map(treeOf),
  } as unknown as FolderNode;
}

export interface OfflineSend {
  collectionDir: string;
  requestId: string;
  /** Environment directory, if one is selected. */
  environmentDir?: string;
  /** Values kept outside the repository (for example from `.env`); they win over same-named variables. */
  localVariables?: Record<string, string>;
  /** Host rules, same patterns as PROXY_ALLOW_HOSTS / PROXY_DENY_HOSTS. */
  allowHosts?: string[];
  denyHosts?: string[];
  signal?: AbortSignal;
}

/** Runs one request of a repository directory with the engine and returns what the editor shows. */
export async function sendOffline(access: FileAccess, root: string, input: OfflineSend): Promise<ViewResult> {
  const all = (await access.listFiles(root)).slice(0, 20_000);
  const collection = filesToSnapshot(await readSet(access, root, input.collectionDir, all)).snapshot;
  const tree = treeOf(collection.root) as FolderNode;
  const environment: Variable[] = input.environmentDir
    ? filesToEnvironment(await readSet(access, root, input.environmentDir, all)).snapshot.variables
    : [];
  const local = input.localVariables ?? {};
  const overridden = [
    ...environment.filter((variable) => !(variable.key in local)),
    ...Object.entries(local).map(
      ([key, value]) => ({ key, value, type: "secret", enabled: true }) as Variable,
    ),
  ];
  const logs: { level: string; message: string }[] = [];
  const onEvent = (event: RunEvent) => {
    if (event.type === "log")
      for (const entry of event.entries) logs.push({ level: entry.level, message: entry.message });
  };
  const { summary } = await runCollection({
    root: tree,
    scopes: {
      ...emptyScopes(),
      collection: variablesToRecord((collection as Snapshot).variables),
      environment: variablesToRecord(overridden),
    },
    options: {
      ...DEFAULT_RUN_OPTIONS,
      iterations: 1,
      delayMs: 0,
      stopOnFailure: false,
      persistVariables: false,
    },
    selectedRequestIds: [input.requestId],
    cookieJar: new CookieJarStore(),
    policy: new HostPolicy(input.allowHosts ?? [], input.denyHosts ?? []),
    secrets: Object.values(local).filter((value) => value.length >= 4),
    signal: input.signal,
    onEvent,
  });
  const result = summary.results[0];
  if (!result) throw new Error("That request was not found in the collection.");
  return {
    name: result.name,
    method: result.method,
    url: result.url,
    status: result.status,
    statusText: result.statusText ?? "",
    timeMs: result.timeMs,
    size: result.size,
    headers: result.responseHeaders ?? [],
    body: result.responseBody ?? "",
    tests: result.tests,
    logs,
    error: result.error,
    warnings: [],
  };
}
