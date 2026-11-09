import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCliBundle } from "./helpers/cli-bundle";

const exec = promisify(execFile);
let dir: string, cli: string, remote: string;
const request = (url: string) => JSON.stringify({ format: 1, id: "8fK2", url }, null, 2) + "\n";

async function invoke(args: string[], env: Record<string, string> = {}) {
  try {
    const result = await exec(process.execPath, [cli, "git", ...args], {
      cwd: dir,
      timeout: 30000,
      env: { ...process.env, ...env },
    });
    return { ...result, code: 0 };
  } catch (error) {
    return error as Error & { stdout: string; stderr: string; code: number };
  }
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "postbox-git-cli-"));
  cli = await buildCliBundle(dir);
  remote = path.join(dir, "remote.git");
  await exec("git", ["init", "--bare", "--initial-branch", "main", remote]);
}, 60000);
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("postbox git", () => {
  it("connects, commits, pushes and pulls with stable exit codes", async () => {
    const a = path.join(dir, "a");
    const b = path.join(dir, "b");
    let result = await invoke(["connect", "-d", a, "--remote", remote, "--allow-local"]);
    expect(result.code, result.stderr).toBe(0);
    await writeFile(path.join(a, "x--8fK2.request.json"), request("https://a.example.test"));
    result = await invoke(["status", "-d", a, "--json"]);
    expect(JSON.parse(result.stdout).changes).toHaveLength(1);
    expect((await invoke(["commit", "-d", a, "-m", "Add x"])).code).toBe(0);
    expect((await invoke(["push", "-d", a, "--allow-local"])).code).toBe(0);

    await invoke(["connect", "-d", b, "--remote", remote, "--allow-local"]);
    result = await invoke(["pull", "-d", b, "--allow-local"]);
    expect(result.stdout).toContain("fast-forward");
    expect(await readFile(path.join(b, "x--8fK2.request.json"), "utf8")).toContain("a.example.test");

    // A conflicting edit exits 5 and lists the file; abort restores it.
    await writeFile(path.join(a, "x--8fK2.request.json"), request("https://one.example.test"));
    await invoke(["commit", "-d", a, "-m", "one"]);
    await invoke(["push", "-d", a, "--allow-local"]);
    await writeFile(path.join(b, "x--8fK2.request.json"), request("https://two.example.test"));
    await invoke(["commit", "-d", b, "-m", "two"]);
    result = await invoke(["pull", "-d", b, "--allow-local"]);
    expect(result.code).toBe(5);
    expect(result.stdout).toContain("x--8fK2.request.json");
    expect((await invoke(["abort", "-d", b])).code).toBe(0);
  }, 60000);

  it("uses usage exit codes for refused input", async () => {
    const result = await invoke([
      "connect",
      "-d",
      path.join(dir, "c"),
      "--remote",
      "http://example.test/a.git",
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/https or ssh/);
    const denied = await invoke(
      ["connect", "-d", path.join(dir, "d"), "--remote", "https://git.blocked.test/a.git"],
      {
        PROXY_DENY_HOSTS: "git.blocked.test",
      },
    );
    expect(denied.code).toBe(5);
  }, 60000);
});
