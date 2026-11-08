import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as git from "../src/core/git/adapter";
import { assertBranchName, configKeys, dangerousConfig, parseRemote, scrub } from "../src/core/git/safe";
import { HostPolicy } from "../src/core/http/policy";

let root: string;
let remote: string;
const options: git.GitOptions = {
  allowLocal: true,
  author: { name: "Tester", email: "tester@example.test" },
};
const write = (dir: string, file: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
};
const read = (dir: string, file: string) => fs.readFileSync(path.join(dir, file), "utf8");
const request = (name: string, url: string) =>
  JSON.stringify({ format: 1, id: "8fK2", method: "GET", name, url }, null, 2) + "\n";
const fresh = (name: string) => path.join(root, name);

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-git-"));
  remote = path.join(root, "remote.git");
  execFileSync("git", ["init", "--bare", "--initial-branch", "main", remote], { stdio: "ignore" });
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe("validation", () => {
  it("accepts plain branch names only", () => {
    expect(assertBranchName("feature/new-thing")).toBe("feature/new-thing");
    for (const bad of ["-D", "--force", "a..b", "x.lock", ".hidden", "a b", "", "HEAD", "a//b", "ends/"])
      expect(() => assertBranchName(bad)).toThrow();
  });
  it("accepts https, ssh and scp-style remotes and refuses everything else", () => {
    expect(parseRemote("https://github.com/acme/api.git")).toMatchObject({
      host: "github.com",
      protocol: "https",
    });
    expect(parseRemote("git@github.com:acme/api.git")).toMatchObject({ host: "github.com", protocol: "ssh" });
    expect(parseRemote("ssh://git@git.example.test:2222/acme/api.git")).toMatchObject({
      host: "git.example.test",
    });
    for (const bad of [
      "http://example.test/a.git",
      "git://example.test/a.git",
      "ext::sh -c touch% /tmp/x",
      "https://user:pass@example.test/a.git",
      "https://token@example.test/a.git",
      "--upload-pack=touch /tmp/x",
      "/some/local/path",
      "file:///tmp/repo",
    ])
      expect(() => parseRemote(bad)).toThrow();
    expect(parseRemote("/some/local/path", { allowLocal: true })).toMatchObject({ host: null });
  });
  it("flags repository config that can run programs", () => {
    const keys = configKeys(
      "core.bare\ntrue\0filter.lfs.clean\ngit-lfs clean\0core.fsmonitor\n/x\0alias.x\n!sh\0remote.origin.url\nhttps://a\0diff.foo.textconv\ncat\0",
    );
    expect(dangerousConfig(keys)).toEqual([
      "alias.x",
      "core.fsmonitor",
      "diff.foo.textconv",
      "filter.lfs.clean",
    ]);
    expect(dangerousConfig(["core.bare", "remote.origin.url", "branch.main.remote"])).toEqual([]);
  });
  it("scrubs secrets from output", () => {
    expect(scrub("fatal: auth failed for ghp_abcdef1234", ["ghp_abcdef1234"])).toBe(
      "fatal: auth failed for [REDACTED]",
    );
  });
});

describe("git adapter", () => {
  it("parses status for an unconnected directory", async () => {
    const dir = fresh("plain");
    fs.mkdirSync(dir);
    expect((await git.status(dir, options)).repository).toBe(false);
    await expect(git.commit(dir, "x", options)).rejects.toThrow(/not a git repository/);
  });

  it("connects, commits and pushes, and a second checkout pulls it (clean pull)", async () => {
    const a = fresh("a");
    await git.connect(a, { remote, branch: "main" }, options);
    write(a, "collection.json", JSON.stringify({ format: 1, name: "Pets" }, null, 2) + "\n");
    write(a, "list-pets--8fK2.request.json", request("List pets", "https://api.example.test/pets"));
    write(a, ".postbox-repo.json", "{}\n");
    const status = await git.status(a, options);
    expect(status.changes.map((c) => c.path)).toEqual(["collection.json", "list-pets--8fK2.request.json"]);
    expect(status.changes.every((c) => c.state === "untracked")).toBe(true);
    expect((await git.commit(a, "Add pets", options)).committed).toBe(true);
    expect((await git.commit(a, "Again", options)).committed).toBe(false);
    expect((await git.push(a, options)).pushed).toBe(true);
    const after = await git.status(a, options);
    expect(after).toMatchObject({ clean: true, branch: "main", ahead: 0, behind: 0 });
    // The per-machine pull state is never committed.
    expect(execFileSync("git", ["ls-files"], { cwd: a, encoding: "utf8" })).not.toContain(
      ".postbox-repo.json",
    );

    const b = fresh("b");
    await git.connect(b, { remote, branch: "main" }, options);
    const pulled = await git.pull(b, options);
    expect(pulled.outcome).toBe("fast-forward");
    expect(read(b, "list-pets--8fK2.request.json")).toBe(
      request("List pets", "https://api.example.test/pets"),
    );
    expect((await git.pull(b, options)).outcome).toBe("up-to-date");
  });

  it("merges divergent branches that touch different files", async () => {
    const a = fresh("a");
    const b = fresh("b");
    write(a, "other--Qx91.request.json", request("Other", "https://api.example.test/other"));
    await git.commit(a, "Add other", options);
    await git.push(a, options);
    write(b, "third--Pp40.request.json", request("Third", "https://api.example.test/third"));
    await git.commit(b, "Add third", options);
    await expect(git.push(b, options)).rejects.toThrow(/postbox git pull/);
    const merged = await git.pull(b, options);
    expect(merged.outcome).toBe("merged");
    expect(fs.existsSync(path.join(b, "other--Qx91.request.json"))).toBe(true);
    await git.push(b, options);
    expect((await git.pull(a, options)).outcome).toBe("fast-forward");
    expect(fs.existsSync(path.join(a, "third--Pp40.request.json"))).toBe(true);
  });

  it("hands a conflicting file back, then finishes or aborts the merge", async () => {
    const a = fresh("a");
    const b = fresh("b");
    const file = "list-pets--8fK2.request.json";
    write(a, file, request("List pets", "https://a.example.test/pets"));
    await git.commit(a, "Point at a", options);
    await git.push(a, options);
    write(b, file, request("List pets", "https://b.example.test/pets"));
    await git.commit(b, "Point at b", options);

    const conflict = await git.pull(b, options);
    expect(conflict).toMatchObject({ outcome: "conflict", conflicts: [file] });
    expect(read(b, file)).toContain("<<<<<<<");
    const during = await git.status(b, options);
    expect(during).toMatchObject({ merging: true, conflicts: [file] });
    await expect(git.commit(b, "no", options)).rejects.toThrow(/Resolve the conflicts/);
    await expect(git.continueMerge(b, options)).rejects.toThrow(/markers are still in/);

    // Abort restores our side exactly.
    await git.abortMerge(b, options);
    expect(read(b, file)).toBe(request("List pets", "https://b.example.test/pets"));
    expect((await git.status(b, options)).merging).toBe(false);

    // Resolve by hand, and the file is still a valid repository file.
    expect((await git.pull(b, options)).outcome).toBe("conflict");
    write(b, file, request("List pets", "https://merged.example.test/pets"));
    const done = await git.continueMerge(b, options);
    expect(done.summary).toMatch(/Merge/);
    expect(JSON.parse(read(b, file))).toMatchObject({
      format: 1,
      id: "8fK2",
      url: "https://merged.example.test/pets",
    });
    await git.push(b, options);
    expect((await git.pull(a, options)).outcome).toBe("fast-forward");
    expect(read(a, file)).toContain("merged.example.test");
  });

  it("creates and switches branches", async () => {
    const a = fresh("a");
    expect((await git.createBranch(a, "feature/docs", options)).branch).toBe("feature/docs");
    expect((await git.branches(a, options)).names).toEqual(["feature/docs", "main"]);
    expect((await git.switchBranch(a, "main", options)).branch).toBe("main");
    await expect(git.switchBranch(a, "--detach", options)).rejects.toThrow(/branch name/);
  });

  it("refuses to pull over uncommitted changes", async () => {
    const a = fresh("a");
    write(a, "scratch.request.json", request("Scratch", "https://x.example.test"));
    await expect(git.pull(a, options)).rejects.toThrow(/uncommitted changes/);
    fs.rmSync(path.join(a, "scratch.request.json"));
  });
});

describe("git adapter safety", () => {
  it("never runs repository hooks", async () => {
    const dir = fresh("hooks");
    await git.connect(dir, { branch: "main" }, options);
    const marker = path.join(root, "hook-ran");
    for (const hook of ["pre-commit", "commit-msg", "post-commit", "pre-push", "pre-merge-commit"]) {
      const file = path.join(dir, ".git", "hooks", hook);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 });
    }
    write(dir, "a.request.json", request("A", "https://x.example.test"));
    expect((await git.commit(dir, "With hooks lying around", options)).committed).toBe(true);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("refuses a repository whose config can run a program", async () => {
    const dir = fresh("evil");
    await git.connect(dir, { branch: "main" }, options);
    const marker = path.join(root, "filter-ran");
    execFileSync("git", ["config", "--local", "filter.evil.clean", `touch ${marker}`], { cwd: dir });
    write(dir, ".gitattributes", "*.json filter=evil\n");
    write(dir, "a.request.json", request("A", "https://x.example.test"));
    await expect(git.commit(dir, "x", options)).rejects.toThrow(/filter\.evil\.clean/);
    await expect(git.status(dir, options)).rejects.toThrow(/can run programs/);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("applies the host policy to the remote before anything leaves the machine", async () => {
    const dir = fresh("policy");
    const policy = new HostPolicy([], ["git.blocked.test"]);
    await expect(
      git.connect(dir, { remote: "https://git.blocked.test/acme/api.git" }, { ...options, policy }),
    ).rejects.toThrow(/blocked|denied|not allowed/i);
    const ok = await git.connect(
      dir,
      { remote: "https://git.allowed.test/acme/api.git" },
      { ...options, policy },
    );
    expect(ok.repository).toBe(true);
    // A remote added behind our back is checked again at push time.
    execFileSync("git", ["remote", "set-url", "origin", "https://git.blocked.test/acme/api.git"], {
      cwd: dir,
    });
    write(dir, "a.request.json", request("A", "https://x.example.test"));
    await git.commit(dir, "x", options);
    await expect(git.push(dir, { ...options, policy })).rejects.toThrow(/blocked|denied|not allowed/i);
  });

  it("refuses unsupported remotes and local paths unless allowed", async () => {
    await expect(git.connect(fresh("r1"), { remote: "http://example.test/a.git" }, {})).rejects.toThrow(
      /https or ssh/,
    );
    await expect(git.connect(fresh("r2"), { remote: remote }, {})).rejects.toThrow();
  });

  it("requires the token variable to exist and keeps its value out of errors", async () => {
    const dir = fresh("token");
    await git.connect(dir, { remote: "https://127.0.0.1:1/acme/api.git" }, options);
    write(dir, "a.request.json", request("A", "https://x.example.test"));
    await git.commit(dir, "x", options);
    await expect(git.push(dir, { ...options, tokenEnv: "POSTBOX_TEST_MISSING" })).rejects.toThrow(/not set/);
    const env = { ...process.env, POSTBOX_TEST_TOKEN: "tok_secret_value_123" };
    const error = await git
      .push(dir, { ...options, tokenEnv: "POSTBOX_TEST_TOKEN", env, timeoutMs: 20000 })
      .catch((e) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).not.toContain("tok_secret_value_123");
  });
});
