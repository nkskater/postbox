import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCliBundle } from "./helpers/cli-bundle";

const exec = promisify(execFile);
let dir: string, cli: string;

async function invoke(args: string[]) {
  try {
    const result = await exec(process.execPath, [cli, ...args], { cwd: dir, timeout: 30000 });
    return { ...result, code: 0 };
  } catch (error) {
    return error as Error & { stdout: string; stderr: string; code: number };
  }
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "postbox-project-cli-"));
  cli = await buildCliBundle(dir);
}, 60000);
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface Info {
  name: string;
  path: string;
  aliases: string[];
  arguments: { name: string; required: boolean; variadic: boolean }[];
  options: { long?: string; value: string; mandatory: boolean; default?: unknown }[];
  commands: Info[];
}

describe("postbox describe", () => {
  it("prints every command with its arguments, options and the exit codes", async () => {
    const result = await invoke(["describe"]);
    expect(result.code, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout) as {
      format: number;
      cli: string;
      exitCodes: object;
      command: Info;
    };
    expect(output.format).toBe(1);
    expect(output.cli).toBe("postbox");
    expect(output.exitCodes).toMatchObject({ success: 0, usage: 2, invalid: 5 });
    const names = output.command.commands.map((command) => command.name);
    for (const name of ["run", "collection", "git", "init", "doctor", "skills", "describe"])
      expect(names).toContain(name);
    const run = output.command.commands.find((command) => command.name === "run")!;
    expect(run.arguments[0]).toMatchObject({ name: "collection.json", required: true });
    expect(run.options.find((option) => option.long === "--delay")).toMatchObject({
      value: "required",
      default: 0,
    });
    // Deterministic: the same output every time.
    expect((await invoke(["describe"])).stdout).toBe(result.stdout);
  });

  it("narrows to one command, by name or alias, and exits 4 for an unknown one", async () => {
    const pull = JSON.parse((await invoke(["describe", "collection", "pull"])).stdout).command as Info;
    expect(pull.path).toBe("collection pull");
    expect(pull.options.find((option) => option.long === "--dir")).toBeTruthy();
    const doctor = JSON.parse((await invoke(["describe", "status"])).stdout).command as Info;
    expect(doctor).toMatchObject({ name: "doctor", path: "doctor", aliases: ["status"] });
    expect((await invoke(["describe", "nope"])).code).toBe(4);
  });
});

describe("postbox init, doctor and skills", () => {
  it("creates a project that passes doctor, without overwriting files", async () => {
    const project = path.join(dir, "orders");
    let result = await invoke(["init", project, "--name", "Orders", "--json"]);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).files.map((f: { action: string }) => f.action)).toEqual([
      "created",
      "created",
      "created",
      "created",
    ]);
    result = await invoke(["init", project]);
    expect(result.stdout).toContain("kept (exists)  postbox.json");

    result = await invoke(["doctor", project, "--json"]);
    expect(result.code, result.stdout).toBe(0);
    expect(JSON.parse(result.stdout).ok).toBe(true);

    await writeFile(path.join(project, "postbox.json"), "{}");
    result = await invoke(["status", project]);
    expect(result.code).toBe(5);
    expect(result.stdout).toMatch(/FAIL\s+config/);

    expect((await invoke(["init", project, "--base-url", "ftp://x"])).code).toBe(2);
  });

  it("installs opted-in skills only into the given directory and keeps local edits", async () => {
    const skills = path.join(dir, "skills");
    expect((await invoke(["skills", "install", "postbox-project"])).code).toBe(2);
    expect((await invoke(["skills", "install", "--dir", skills])).code).toBe(2);
    expect((await invoke(["skills", "install", "--dir", skills, "nope"])).code).toBe(2);

    let result = await invoke(["skills", "install", "--dir", skills, "postbox-project"]);
    expect(result.code, result.stderr).toBe(0);
    await writeFile(path.join(skills, "postbox-project/SKILL.md"), "edited\n");
    result = await invoke(["skills", "update", "--dir", skills, "--json"]);
    expect(JSON.parse(result.stdout).changes).toEqual([
      { skill: "postbox-project", path: "SKILL.md", action: "kept-edited" },
    ]);
    expect(await readFile(path.join(skills, "postbox-project/SKILL.md"), "utf8")).toBe("edited\n");

    result = await invoke(["skills", "list", "--dir", skills, "--json"]);
    const states = Object.fromEntries(
      (JSON.parse(result.stdout) as { name: string; state: string }[]).map((s) => [s.name, s.state]),
    );
    expect(states).toMatchObject({ "postbox-project": "edited", "postbox-collection-runs": "not-installed" });

    expect((await invoke(["skills", "update", "--dir", skills, "postbox-collection-runs"])).code).toBe(2);
  });
});
