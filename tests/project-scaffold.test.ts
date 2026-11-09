import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkProject } from "../src/core/project/doctor";
import { isInsideProject, projectFiles, scaffoldProject } from "../src/core/project/scaffold";
import {
  SKILL_MANIFEST,
  SKILLS,
  installSkills,
  readManifest,
  resolveSkills,
  sha256,
  skillStatus,
  type Skill,
} from "../src/core/project/skills";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "postbox-project-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const read = (file: string) => readFile(path.join(dir, file), "utf8");
const options = { name: "Orders API", baseUrl: "http://localhost:8080" };

describe("postbox init scaffolding", () => {
  it("produces the same files for the same options", () => {
    expect(projectFiles(options)).toEqual(projectFiles(options));
    expect(projectFiles(options).map((file) => file.path)).toEqual([
      "postbox.json",
      "collections/orders-api.postman_collection.json",
      "environments/local.postman_environment.json",
      ".gitignore",
    ]);
  });

  it("creates missing files and never overwrites existing ones", async () => {
    await writeFile(path.join(dir, ".gitignore"), "node_modules/\n");
    const results = await scaffoldProject(dir, options);
    expect(results.map((r) => `${r.action} ${r.path}`)).toEqual([
      "created postbox.json",
      "created collections/orders-api.postman_collection.json",
      "created environments/local.postman_environment.json",
      "kept .gitignore",
    ]);
    expect(await read(".gitignore")).toBe("node_modules/\n");
    expect(JSON.parse(await read("environments/local.postman_environment.json")).values[0].value).toBe(
      "http://localhost:8080",
    );

    await writeFile(path.join(dir, "postbox.json"), '{"edited": true}\n');
    await scaffoldProject(dir, options);
    expect(await read("postbox.json")).toBe('{"edited": true}\n');
  });

  it("only fills in files an existing config refers to", async () => {
    await scaffoldProject(dir, options);
    await rm(path.join(dir, "environments"), { recursive: true });
    const results = await scaffoldProject(dir, { name: "Other", baseUrl: "http://localhost:1" });
    expect(results.filter((r) => r.action === "created").map((r) => r.path)).toEqual([
      "environments/local.postman_environment.json",
    ]);
    expect(results.some((r) => r.path.includes("other"))).toBe(false);
  });

  it("writes nothing on a dry run", async () => {
    const results = await scaffoldProject(dir, options, { dryRun: true });
    expect(results.every((r) => r.action === "created")).toBe(true);
    await expect(read("postbox.json")).rejects.toThrow();
  });

  it("accepts only relative paths inside the project", () => {
    expect(isInsideProject("collections/a.json")).toBe(true);
    for (const bad of ["/etc/passwd", "../x.json", "a/../../x", "a\\b", ".."])
      expect(isInsideProject(bad)).toBe(false);
  });
});

describe("postbox doctor checks", () => {
  it("passes a fresh project and warns about Git", async () => {
    await scaffoldProject(dir, options);
    const report = await checkProject(dir, { nodeVersion: "22.13.0" });
    expect(report.ok).toBe(true);
    expect(report.checks.map((c) => `${c.status} ${c.id}`)).toEqual([
      "ok node",
      "ok config",
      "ok collection:collections/orders-api.postman_collection.json",
      "ok environment",
      "ok reports",
      expect.stringMatching(/^(ok|warn) git$/),
    ]);
  });

  it("is stable for the same files", async () => {
    await scaffoldProject(dir, options);
    expect(await checkProject(dir, { nodeVersion: "22.13.0" })).toEqual(
      await checkProject(dir, { nodeVersion: "22.13.0" }),
    );
  });

  it("fails without a config and points at init", async () => {
    const report = await checkProject(dir, { nodeVersion: "22.13.0" });
    expect(report.ok).toBe(false);
    expect(report.checks.at(-1)).toMatchObject({ id: "config", status: "fail" });
    expect(report.checks.at(-1)!.message).toContain("postbox init");
  });

  it("reports old Node, bad config paths, broken collections and missing data", async () => {
    await writeFile(
      path.join(dir, "postbox.json"),
      JSON.stringify({ format: 1, name: "x", collections: ["../outside.json"] }),
    );
    let report = await checkProject(dir, { nodeVersion: "20.0.0" });
    expect(report.checks[0]).toMatchObject({ id: "node", status: "fail" });
    expect(report.checks[1]).toMatchObject({ id: "config", status: "fail" });

    await mkdir(path.join(dir, "c"));
    await writeFile(path.join(dir, "c/empty.json"), JSON.stringify({ info: { name: "e" }, item: [] }));
    await writeFile(path.join(dir, "c/bad.json"), "{");
    await writeFile(
      path.join(dir, "postbox.json"),
      JSON.stringify({
        format: 1,
        name: "x",
        collections: ["c/empty.json", "c/bad.json", "c/missing.json"],
        data: "rows.csv",
      }),
    );
    report = await checkProject(dir, { nodeVersion: "22.13.0" });
    expect(report.ok).toBe(false);
    const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
    expect(byId["collection:c/empty.json"]).toMatchObject({ status: "fail", message: "has no requests" });
    expect(byId["collection:c/bad.json"].status).toBe("fail");
    expect(byId["collection:c/missing.json"]).toMatchObject({ status: "fail", message: "not found" });
    expect(byId.data).toMatchObject({ status: "fail" });
    expect(byId.reports.status).toBe("warn");
  });

  it("reports the state of installed skills", async () => {
    await scaffoldProject(dir, options);
    const config = JSON.parse(await read("postbox.json"));
    await writeFile(path.join(dir, "postbox.json"), JSON.stringify({ ...config, skills: "skills" }));
    let report = await checkProject(dir, { nodeVersion: "22.13.0" });
    expect(report.checks.at(-1)).toMatchObject({ id: "skills", status: "warn" });

    await installSkills(path.join(dir, "skills"), resolveSkills(["postbox-project"]));
    await writeFile(path.join(dir, "skills/postbox-project/SKILL.md"), "mine\n");
    report = await checkProject(dir, { nodeVersion: "22.13.0" });
    expect(report.checks.at(-1)).toMatchObject({ id: "skill:postbox-project", status: "warn" });
    expect(report.ok).toBe(true);

    await rm(path.join(dir, "skills/postbox-project/SKILL.md"));
    report = await checkProject(dir, { nodeVersion: "22.13.0" });
    expect(report.checks.at(-1)).toMatchObject({ id: "skill:postbox-project", status: "fail" });
  });
});

describe("postbox skills", () => {
  const skill = (version: string, files: Record<string, string>): Skill => ({
    name: "postbox-project",
    version,
    description: "test",
    files: Object.entries(files).map(([file, content]) => ({ path: file, content })),
  });

  it("ships versioned skills with front matter matching the catalog", () => {
    expect(new Set(SKILLS.map((s) => s.name)).size).toBe(SKILLS.length);
    for (const s of SKILLS) {
      const text = s.files.find((file) => file.path === "SKILL.md")!.content;
      expect(text.startsWith(`---\nname: ${s.name}\n`)).toBe(true);
      expect(text).toContain(`version: "${s.version}"`);
      expect(s.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(text).not.toMatch(/claude|anthropic/i);
    }
    expect(() => resolveSkills(["postbox-project", "nope"])).toThrow(/Unknown skill: nope/);
  });

  it("installs, records hashes and reports state", async () => {
    const changes = await installSkills(dir, SKILLS);
    expect(changes.every((change) => change.action === "created")).toBe(true);
    const manifest = await readManifest(dir);
    expect(Object.keys(manifest.skills)).toEqual([...SKILLS.map((s) => s.name)].sort());
    const text = await read(`${SKILLS[0].name}/SKILL.md`);
    expect(manifest.skills[SKILLS[0].name].files["SKILL.md"]).toBe(sha256(text));
    expect((await skillStatus(dir)).every((s) => s.state === "current")).toBe(true);
    // A second install changes nothing and the manifest bytes are stable.
    const before = await read(SKILL_MANIFEST);
    expect((await installSkills(dir, SKILLS)).every((c) => c.action === "unchanged")).toBe(true);
    expect(await read(SKILL_MANIFEST)).toBe(before);
  });

  it("updates unedited files, keeps edited ones and removes files no longer shipped", async () => {
    await installSkills(dir, [skill("1.0.0", { "SKILL.md": "v1\n", "notes.md": "n1\n", "old.md": "o1\n" })]);
    await writeFile(path.join(dir, "postbox-project/notes.md"), "my notes\n");
    expect((await skillStatus(dir)).find((s) => s.name === "postbox-project")).toMatchObject({
      state: "edited",
      edited: ["notes.md"],
    });

    const next = skill("1.1.0", { "SKILL.md": "v2\n", "notes.md": "n2\n" });
    const changes = await installSkills(dir, [next]);
    expect(changes.map((c) => `${c.action} ${c.path}`)).toEqual([
      "updated SKILL.md",
      "kept-edited notes.md",
      "removed old.md",
    ]);
    expect(await read("postbox-project/SKILL.md")).toBe("v2\n");
    expect(await read("postbox-project/notes.md")).toBe("my notes\n");
    await expect(read("postbox-project/old.md")).rejects.toThrow();
    // The edited file is still reported as edited after the update.
    const manifest = await readManifest(dir);
    expect(manifest.skills["postbox-project"]).toEqual({
      version: "1.1.0",
      files: { "SKILL.md": sha256("v2\n"), "notes.md": sha256("n1\n") },
    });

    expect((await installSkills(dir, [next], { force: true })).map((c) => c.action)).toEqual([
      "unchanged",
      "updated",
    ]);
    expect(await read("postbox-project/notes.md")).toBe("n2\n");
  });

  it("does not replace a file it did not install", async () => {
    await mkdir(path.join(dir, "postbox-project"), { recursive: true });
    await writeFile(path.join(dir, "postbox-project/SKILL.md"), "someone else's\n");
    const changes = await installSkills(dir, [skill("1.0.0", { "SKILL.md": "v1\n" })]);
    expect(changes[0].action).toBe("kept-untracked");
    expect(await read("postbox-project/SKILL.md")).toBe("someone else's\n");
    expect((await skillStatus(dir)).find((s) => s.name === "postbox-project")?.state).toBe("edited");
  });

  it("reports an outdated install and writes nothing on a dry run", async () => {
    await installSkills(dir, [skill("0.9.0", { "SKILL.md": "old\n" })]);
    expect((await skillStatus(dir)).find((s) => s.name === "postbox-project")).toMatchObject({
      installed: "0.9.0",
      state: "outdated",
    });
    const changes = await installSkills(dir, resolveSkills(["postbox-project"]), { dryRun: true });
    expect(changes[0].action).toBe("updated");
    expect(await read("postbox-project/SKILL.md")).toBe("old\n");
    expect((await readManifest(dir)).skills["postbox-project"].version).toBe("0.9.0");
  });

  it("rejects a corrupt manifest", async () => {
    await writeFile(path.join(dir, SKILL_MANIFEST), "{");
    await expect(installSkills(dir, SKILLS)).rejects.toThrow(/not a valid skills manifest/);
  });
});

describe("skill manifest safety", () => {
  it("rejects traversal in recorded files before updating or removing anything", async () => {
    await writeFile(
      path.join(dir, SKILL_MANIFEST),
      JSON.stringify({
        format: 1,
        skills: {
          [SKILLS[0].name]: { version: "old", files: { "../../outside.txt": sha256("keep") } },
        },
      }),
    );
    await expect(installSkills(dir, [SKILLS[0]], { force: true })).rejects.toThrow(
      "not a valid skills manifest",
    );
  });

  it("keeps tracking edited retired files across repeated updates", async () => {
    const old = { ...SKILLS[0], files: [...SKILLS[0].files, { path: "retired.txt", content: "original" }] };
    await installSkills(dir, [old]);
    await writeFile(path.join(dir, old.name, "retired.txt"), "local changes");
    await installSkills(dir, [SKILLS[0]]);
    expect((await readManifest(dir)).skills[old.name].files["retired.txt"]).toBe(sha256("original"));
    expect(await installSkills(dir, [SKILLS[0]])).toContainEqual({
      skill: old.name,
      path: "retired.txt",
      action: "kept-removed",
    });
    expect(await read(path.join(old.name, "retired.txt"))).toBe("local changes");
  });
});

it("refuses linked project and skill directories", async () => {
  const destination = path.join(dir, "outside");
  await mkdir(destination);
  await symlink(destination, path.join(dir, "collections"), "junction");
  await expect(scaffoldProject(dir, options)).rejects.toThrow("Refusing symbolic link");
  await expect(readFile(path.join(destination, "orders-api.postman_collection.json"))).rejects.toThrow();
  await symlink(destination, path.join(dir, SKILLS[0].name), "junction");
  await expect(installSkills(dir, [SKILLS[0]], { force: true })).rejects.toThrow("Refusing symbolic link");
  await expect(readFile(path.join(destination, "SKILL.md"))).rejects.toThrow();
});

it("accepts supported Node 20 installations in doctor", async () => {
  await scaffoldProject(dir, options);
  expect((await checkProject(dir, { nodeVersion: "20.19.0" })).ok).toBe(true);
  expect((await checkProject(dir, { nodeVersion: "20.18.0" })).ok).toBe(false);
});
