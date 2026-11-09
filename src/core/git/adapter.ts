/**
 * Drives git for a repository directory written by `collection pull` (see docs/git-adapter.md).
 *
 * Git is spawned without a shell, with a fixed environment, a fixed set of sub-commands and options we build
 * ourselves, hooks pointed at an empty directory, no external diff/merge/filter programs, and no global or
 * system configuration. A repository whose own config could run a program is refused. The remote's host
 * goes through the same HostPolicy as every other outbound request.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HostPolicy } from "../http/policy";
import { assertBranchName, configKeys, dangerousConfig, GitUsageError, parseRemote, scrub } from "./safe";

export { GitUsageError } from "./safe";

const COMMANDS = new Set([
  "init",
  "status",
  "add",
  "commit",
  "branch",
  "switch",
  "fetch",
  "merge",
  "push",
  "diff",
  "remote",
  "config",
  "rev-parse",
  "log",
  "check-ref-format",
]);
const MAX_OUTPUT = 8 * 1024 * 1024;
const MARKER = /^(<<<<<<<|=======|>>>>>>>)( |$)/m;

export class GitError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
  ) {
    super(message);
    this.name = "GitError";
  }
}

export interface GitOptions {
  /** Applied to the remote's host before anything leaves the machine. */
  policy?: HostPolicy;
  /** Remote URLs that are local paths (for fixtures and air-gapped mirrors). */
  allowLocal?: boolean;
  /** Name of the environment variable that holds the token for https remotes. */
  tokenEnv?: string;
  /** Username for the token (default `x-access-token`, which GitHub, GitLab and Gitea accept). */
  username?: string;
  /** Identity for commits and merges (git's own global config is never read). */
  author?: { name: string; email: string };
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

interface Run {
  stdout: string;
  stderr: string;
  code: number;
}

let hooksDir: string | null = null;
let askpassDir: string | null = null;
/** An empty directory standing in for `core.hooksPath`, so no repository hook can ever run. */
function emptyHooks() {
  hooksDir ??= fs.mkdtempSync(path.join(os.tmpdir(), "postbox-nohooks-"));
  return hooksDir;
}
function askpass() {
  if (!askpassDir) {
    askpassDir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-askpass-"));
    const unix =
      '#!/bin/sh\ncase "$1" in\n*sername*) printf "%s\\n" "$POSTBOX_GIT_USERNAME";;\n*) printf "%s\\n" "$POSTBOX_GIT_TOKEN";;\nesac\n';
    const windows =
      '@echo off\r\necho %1 | findstr /i "sername" >nul\r\nif %errorlevel%==0 (echo %POSTBOX_GIT_USERNAME%) else (echo %POSTBOX_GIT_TOKEN%)\r\n';
    fs.writeFileSync(path.join(askpassDir, "askpass.sh"), unix, { mode: 0o700 });
    fs.writeFileSync(path.join(askpassDir, "askpass.cmd"), windows);
  }
  return path.join(askpassDir, process.platform === "win32" ? "askpass.cmd" : "askpass.sh");
}

function childEnv(options: GitOptions, secrets: string[]): Record<string, string | undefined> {
  const source = options.env ?? process.env;
  const env: Record<string, string | undefined> = {
    PATH: source.PATH ?? "",
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_EDITOR: "true",
    GIT_PAGER: "cat",
    GIT_ASKPASS: askpass(),
    SSH_ASKPASS: "",
    GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o StrictHostKeyChecking=yes",
  };
  for (const name of ["HOME", "USERPROFILE", "SystemRoot", "TMPDIR", "TEMP", "TMP", "SSH_AUTH_SOCK"])
    if (source[name]) env[name] = source[name];
  if (options.tokenEnv) {
    const token = source[options.tokenEnv];
    if (!token) throw new GitUsageError(`The environment variable ${options.tokenEnv} is not set.`);
    env.POSTBOX_GIT_TOKEN = token;
    env.POSTBOX_GIT_USERNAME = options.username ?? "x-access-token";
    secrets.push(token);
  }
  return env;
}

function settings(options: GitOptions): string[] {
  const identity = options.author ?? { name: "Postbox", email: "postbox@localhost" };
  const pairs: [string, string][] = [
    ["core.hooksPath", emptyHooks()],
    ["core.fsmonitor", "false"],
    ["core.attributesFile", os.devNull],
    ["core.quotePath", "false"],
    ["core.autocrlf", "false"],
    ["core.symlinks", "false"],
    ["credential.helper", ""],
    ["diff.external", ""],
    ["gc.auto", "0"],
    ["maintenance.auto", "false"],
    ["submodule.recurse", "false"],
    ["commit.gpgSign", "false"],
    ["tag.gpgSign", "false"],
    ["merge.autoStash", "false"],
    ["protocol.allow", "never"],
    ["protocol.https.allow", "always"],
    ["protocol.ssh.allow", "always"],
    ["protocol.file.allow", options.allowLocal ? "always" : "never"],
    ["user.name", identity.name],
    ["user.email", identity.email],
  ];
  return pairs.flatMap(([key, value]) => ["-c", `${key}=${value}`]);
}

function run(cwd: string, args: string[], options: GitOptions, extraSecrets: string[] = []): Promise<Run> {
  const [command] = args;
  if (!COMMANDS.has(command)) throw new GitUsageError(`git ${command} is not permitted.`);
  const secrets = [...extraSecrets];
  const env = childEnv(options, secrets);
  return new Promise((resolve, reject) => {
    const child = spawn("git", [...settings(options), ...args], {
      cwd,
      env: env as NodeJS.ProcessEnv,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let size = 0;
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 120_000);
    const take = (target: "out" | "err") => (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OUTPUT) {
        child.kill("SIGKILL");
        return;
      }
      if (target === "out") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    };
    child.stdout.on("data", take("out"));
    child.stderr.on("data", take("err"));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(
        new GitError(
          (error as NodeJS.ErrnoException).code === "ENOENT"
            ? "git is not installed or not on PATH."
            : scrub(error.message, secrets),
          null,
        ),
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout: scrub(stdout, secrets), stderr: scrub(stderr, secrets), code: code ?? -1 });
    });
  });
}

async function ok(cwd: string, args: string[], options: GitOptions): Promise<string> {
  const result = await run(cwd, args, options);
  if (result.code !== 0)
    throw new GitError((result.stderr || result.stdout).trim() || `git ${args[0]} failed`, result.code);
  return result.stdout;
}

/** Refuse a repository whose own configuration could run a program or redirect traffic. */
async function assertSafeRepository(dir: string, options: GitOptions) {
  const dump = await run(dir, ["config", "--local", "--list", "-z"], options);
  if (dump.code !== 0) return;
  const bad = dangerousConfig(configKeys(dump.stdout));
  if (bad.length)
    throw new GitUsageError(
      `This repository's .git/config sets ${bad.join(", ")}, which can run programs or redirect traffic. Remove it or use a fresh clone.`,
    );
}

function assertRemoteAllowed(url: string, options: GitOptions) {
  const target = parseRemote(url, { allowLocal: options.allowLocal });
  if (target.host && options.policy) options.policy.assert(target.host);
  return target;
}

export interface GitChange {
  path: string;
  /** Two-letter porcelain code (index, worktree), `U` marks an unmerged path. */
  code: string;
  state: "added" | "modified" | "deleted" | "renamed" | "untracked" | "conflicted" | "other";
  from?: string;
}
export interface GitStatus {
  repository: boolean;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  clean: boolean;
  merging: boolean;
  changes: GitChange[];
  conflicts: string[];
}

function stateOf(code: string): GitChange["state"] {
  if (code.includes("U") || code === "AA" || code === "DD") return "conflicted";
  if (code.includes("R")) return "renamed";
  if (code.includes("A")) return "added";
  if (code.includes("D")) return "deleted";
  if (code.includes("M") || code.includes("T")) return "modified";
  return "other";
}

/** Parse `git status --porcelain=v2 --branch -z`. */
export function parseStatus(output: string): Omit<GitStatus, "repository" | "merging"> {
  const status = {
    branch: null as string | null,
    upstream: null as string | null,
    ahead: 0,
    behind: 0,
    clean: true,
    changes: [] as GitChange[],
    conflicts: [] as string[],
  };
  const records = output.split("\0");
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    if (record.startsWith("# branch.head ")) {
      const head = record.slice("# branch.head ".length);
      status.branch = head === "(detached)" ? null : head;
    } else if (record.startsWith("# branch.upstream "))
      status.upstream = record.slice("# branch.upstream ".length);
    else if (record.startsWith("# branch.ab ")) {
      const match = /\+(\d+) -(\d+)/.exec(record);
      if (match) [status.ahead, status.behind] = [Number(match[1]), Number(match[2])];
    } else if (record.startsWith("1 ")) {
      const parts = record.split(" ");
      const code = parts[1].replace(/\./g, " ");
      status.changes.push({ path: parts.slice(8).join(" "), code: parts[1], state: stateOf(code) });
    } else if (record.startsWith("2 ")) {
      const parts = record.split(" ");
      status.changes.push({
        path: parts.slice(9).join(" "),
        code: parts[1],
        state: "renamed",
        from: records[++i],
      });
    } else if (record.startsWith("u ")) {
      const parts = record.split(" ");
      const file = parts.slice(10).join(" ");
      status.changes.push({ path: file, code: parts[1], state: "conflicted" });
      status.conflicts.push(file);
    } else if (record.startsWith("? "))
      status.changes.push({ path: record.slice(2), code: "??", state: "untracked" });
  }
  status.clean = status.changes.length === 0;
  status.changes.sort((a, b) => a.path.localeCompare(b.path));
  status.conflicts.sort();
  return status;
}

function isRepository(dir: string) {
  return fs.existsSync(path.join(dir, ".git"));
}
function merging(dir: string) {
  return fs.existsSync(path.join(dir, ".git", "MERGE_HEAD"));
}
function need(dir: string) {
  if (!isRepository(dir))
    throw new GitUsageError(`${dir} is not a git repository yet. Run \`postbox git connect\` first.`);
}

const IGNORE = [".postbox-repo.json"];
/** The pull state file is per machine (it records what was pulled here), so it is never committed. */
function excludeLocalState(dir: string) {
  const file = path.join(dir, ".git", "info", "exclude");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const missing = IGNORE.filter((line) => !current.split(/\r?\n/).includes(line));
  if (missing.length)
    fs.appendFileSync(file, (current && !current.endsWith("\n") ? "\n" : "") + missing.join("\n") + "\n");
}

export async function status(dir: string, options: GitOptions = {}): Promise<GitStatus> {
  if (!isRepository(dir))
    return {
      repository: false,
      branch: null,
      upstream: null,
      ahead: 0,
      behind: 0,
      clean: true,
      merging: false,
      changes: [],
      conflicts: [],
    };
  await assertSafeRepository(dir, options);
  const output = await ok(
    dir,
    ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"],
    options,
  );
  return { repository: true, merging: merging(dir), ...parseStatus(output) };
}

/** Make `dir` a repository (creating it if needed) and optionally point `origin` at a remote. */
export async function connect(
  dir: string,
  input: { remote?: string; branch?: string },
  options: GitOptions = {},
): Promise<GitStatus> {
  const branch = assertBranchName(input.branch ?? "main");
  const target = input.remote ? assertRemoteAllowed(input.remote, options) : null;
  fs.mkdirSync(dir, { recursive: true });
  if (!isRepository(dir)) await ok(dir, ["init", "--initial-branch", branch], options);
  else await assertSafeRepository(dir, options);
  excludeLocalState(dir);
  if (target) {
    const remotes = (await ok(dir, ["remote"], options)).split(/\r?\n/).filter(Boolean);
    await ok(dir, ["remote", remotes.includes("origin") ? "set-url" : "add", "origin", target.url], options);
  }
  return status(dir, options);
}

export async function diff(dir: string, options: GitOptions = {}): Promise<string> {
  need(dir);
  await assertSafeRepository(dir, options);
  const flags = ["--no-ext-diff", "--no-textconv", "--no-color"];
  const tracked = await ok(dir, ["diff", ...flags, "HEAD", "--"], options).catch(() =>
    ok(dir, ["diff", ...flags, "--"], options),
  );
  return tracked;
}

export async function commit(
  dir: string,
  message: string,
  options: GitOptions = {},
): Promise<{ committed: boolean; summary: string }> {
  need(dir);
  if (!message.trim()) throw new GitUsageError("A commit needs a message.");
  const before = await status(dir, options);
  if (before.conflicts.length)
    throw new GitUsageError(`Resolve the conflicts first: ${before.conflicts.join(", ")}.`);
  if (before.merging)
    throw new GitUsageError("A merge is in progress. Run `postbox git continue` after resolving it.");
  await ok(dir, ["add", "--all", "--", "."], options);
  const staged = await run(dir, ["status", "--porcelain=v2", "-z"], options);
  if (!staged.stdout.split("\0").some((record) => /^[12u] /.test(record)))
    return { committed: false, summary: "Nothing to commit." };
  await ok(dir, ["commit", "--no-verify", "--no-gpg-sign", "--message", message], options);
  return { committed: true, summary: (await ok(dir, ["log", "-1", "--format=%h %s"], options)).trim() };
}

export async function branches(
  dir: string,
  options: GitOptions = {},
): Promise<{ current: string | null; names: string[] }> {
  need(dir);
  await assertSafeRepository(dir, options);
  const names = (await ok(dir, ["branch", "--format=%(refname:short)"], options))
    .split(/\r?\n/)
    .filter(Boolean)
    .sort();
  const current = (await status(dir, options)).branch;
  return { current, names };
}

export async function createBranch(dir: string, name: string, options: GitOptions = {}) {
  need(dir);
  assertBranchName(name);
  await assertSafeRepository(dir, options);
  await ok(dir, ["switch", "--create", name], options);
  return status(dir, options);
}

export async function switchBranch(dir: string, name: string, options: GitOptions = {}) {
  need(dir);
  assertBranchName(name);
  await assertSafeRepository(dir, options);
  await ok(dir, ["switch", name], options);
  return status(dir, options);
}

async function originOf(dir: string, options: GitOptions) {
  const remotes = (await ok(dir, ["remote"], options)).split(/\r?\n/).filter(Boolean);
  if (!remotes.includes("origin"))
    throw new GitUsageError("No remote is connected. Use `postbox git connect --remote <url>`.");
  const url = (await ok(dir, ["remote", "get-url", "origin"], options)).trim();
  assertRemoteAllowed(url, options);
  return url;
}

export async function push(
  dir: string,
  options: GitOptions = {},
): Promise<{ branch: string; pushed: boolean; output: string }> {
  need(dir);
  await assertSafeRepository(dir, options);
  await originOf(dir, options);
  const current = await status(dir, options);
  if (!current.branch) throw new GitUsageError("Switch to a branch before pushing.");
  const args = [
    "push",
    "--no-verify",
    "--no-recurse-submodules",
    ...(current.upstream ? [] : ["--set-upstream"]),
    "origin",
    current.branch,
  ];
  const result = await run(dir, args, options);
  if (result.code !== 0) {
    const text = (result.stderr || result.stdout).trim();
    throw new GitError(
      /non-fast-forward|fetch first|rejected/i.test(text)
        ? `The remote has commits you do not have. Run \`postbox git pull\` first.\n${text}`
        : text,
      result.code,
    );
  }
  return { branch: current.branch, pushed: true, output: (result.stderr + result.stdout).trim() };
}

export type PullResult =
  | { outcome: "up-to-date" | "fast-forward" | "merged"; branch: string; summary: string }
  | { outcome: "conflict"; branch: string; conflicts: string[]; summary: string };

/** Fetch and merge the remote branch. A conflicting merge is left in progress for the user to resolve. */
export async function pull(dir: string, options: GitOptions = {}): Promise<PullResult> {
  need(dir);
  await assertSafeRepository(dir, options);
  await originOf(dir, options);
  const before = await status(dir, options);
  if (!before.branch) throw new GitUsageError("Switch to a branch before pulling.");
  if (before.merging)
    throw new GitUsageError("A merge is already in progress. Resolve it, then `postbox git continue`.");
  if (!before.clean) throw new GitUsageError("You have uncommitted changes. Commit them before pulling.");
  await ok(dir, ["fetch", "--prune", "--no-tags", "--no-recurse-submodules", "origin"], options);
  const remoteRef = `origin/${before.branch}`;
  const exists = await run(dir, ["rev-parse", "--verify", "--quiet", `refs/remotes/${remoteRef}`], options);
  if (exists.code !== 0)
    return { outcome: "up-to-date", branch: before.branch, summary: `${remoteRef} does not exist yet.` };
  const head = await run(dir, ["rev-parse", "--verify", "--quiet", "HEAD"], options);
  const merge = await run(
    dir,
    ["merge", "--no-edit", "--no-verify", "--no-gpg-sign", "--no-autostash", "--no-stat", remoteRef],
    options,
  );
  const text = (merge.stdout + merge.stderr).trim();
  if (merge.code === 0) {
    const outcome = /Already up to date/i.test(text)
      ? "up-to-date"
      : /Fast-forward/i.test(text) || head.code !== 0
        ? "fast-forward"
        : "merged";
    return { outcome, branch: before.branch, summary: text.split(/\r?\n/)[0] || outcome };
  }
  const now = await status(dir, options);
  if (now.conflicts.length)
    return {
      outcome: "conflict",
      branch: before.branch,
      conflicts: now.conflicts,
      summary: "Merge stopped on conflicts.",
    };
  throw new GitError(text || "git merge failed", merge.code);
}

/** After the user edited the conflicted files: stage them and finish the merge commit. */
export async function continueMerge(dir: string, options: GitOptions = {}): Promise<{ summary: string }> {
  need(dir);
  await assertSafeRepository(dir, options);
  const current = await status(dir, options);
  if (!current.merging) throw new GitUsageError("No merge is in progress.");
  const leftover = current.conflicts.filter((file) => {
    try {
      return MARKER.test(fs.readFileSync(path.join(dir, file), "utf8"));
    } catch {
      return false;
    }
  });
  if (leftover.length) throw new GitUsageError(`Conflict markers are still in: ${leftover.join(", ")}.`);
  await ok(dir, ["add", "--all", "--", "."], options);
  await ok(dir, ["commit", "--no-verify", "--no-gpg-sign", "--no-edit"], options);
  return { summary: (await ok(dir, ["log", "-1", "--format=%h %s"], options)).trim() };
}

export async function abortMerge(dir: string, options: GitOptions = {}): Promise<void> {
  need(dir);
  await assertSafeRepository(dir, options);
  if (!merging(dir)) throw new GitUsageError("No merge is in progress.");
  await ok(dir, ["merge", "--abort"], options);
}
