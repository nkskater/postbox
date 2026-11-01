import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { buildCliBundle } from "./helpers/cli-bundle";
let directory: string, cli: string;
const exec = promisify(execFile);
beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "postbox-sdk-cli-"));
  cli = await buildCliBundle(directory);
  await writeFile(
    path.join(directory, "api.yaml"),
    'openapi: 3.0.3\ninfo: {title: API, version: 1.0.0}\npaths:\n  /pets:\n    get:\n      responses: {"200": {description: OK}}\n',
  );
}, 30000);
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});
async function invoke(args: string[]) {
  try {
    const result = await exec(process.execPath, [cli, "sdk", "generate", ...args], {
      cwd: directory,
      timeout: 20000,
    });
    return { ...result, code: 0 };
  } catch (error) {
    return error as Error & { stdout: string; stderr: string; code: number };
  }
}
describe("SDK CLI", () => {
  it("generates both installable artifacts and refuses to overwrite existing output", async () => {
    for (const language of ["typescript", "python"]) {
      const args = [
        "api.yaml",
        "--language",
        language,
        "--sdk-version",
        "1.0.0",
        "--name",
        "cli_client",
        "--out-dir",
        language,
        "--json",
      ];
      const result = await invoke(args);
      expect(result.code, result.stderr).toBe(0);
      const metadata = JSON.parse(result.stdout);
      expect(metadata.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect((await readFile(path.join(directory, metadata.output))).length).toBeGreaterThan(200);
      const repeated = await invoke(args);
      expect(repeated.code).toBe(5);
      expect(repeated.stderr).toContain("EEXIST");
    }
  });
  it("uses stable usage/not-found/invalid-source exit codes", async () => {
    expect((await invoke(["api.yaml"])).code).toBe(2);
    expect(
      (
        await invoke([
          "missing.json",
          "--language",
          "typescript",
          "--sdk-version",
          "1.0.0",
          "--out-dir",
          "out",
        ])
      ).code,
    ).toBe(4);
    await writeFile(path.join(directory, "invalid.json"), "{}");
    expect(
      (
        await invoke([
          "invalid.json",
          "--language",
          "typescript",
          "--sdk-version",
          "1.0.0",
          "--out-dir",
          "out",
        ])
      ).code,
    ).toBe(5);
  });
});
