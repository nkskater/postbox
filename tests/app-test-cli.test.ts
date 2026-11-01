import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm, readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { buildCliBundle } from "./helpers/cli-bundle";
let directory: string, cli: string;
const exec = promisify(execFile);
const capture = {
  version: 1,
  entries: [
    {
      request: {
        method: "POST",
        url: "http://127.0.0.1:1/pets?token=source-secret",
        headers: [{ name: "Authorization", value: "Bearer source-secret" }],
        body: '{"name":"Fido"}',
      },
      response: {
        status: 201,
        statusText: "Created",
        headers: [{ name: "Content-Type", value: "application/json" }],
        body: '{"id":7,"token":"source-secret"}',
        timeMs: 3,
      },
    },
  ],
};
beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "postbox-app-cli-"));
  cli = await buildCliBundle(directory);
  await writeFile(
    path.join(directory, "collection.json"),
    JSON.stringify({
      info: {
        name: "Pet API",
        schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
      },
      item: [
        {
          name: "Create pet",
          request: {
            method: "POST",
            url: "http://127.0.0.1:1/pets",
            body: { mode: "raw", raw: '{"name":"Fido"}' },
          },
          event: [
            {
              listen: "test",
              script: {
                exec: [
                  'pm.test("created",()=>pm.response.to.have.status(201)); pm.test("body",()=>pm.expect(pm.response.json().id).to.equal(7));',
                ],
              },
            },
          ],
        },
      ],
    }),
  );
  await writeFile(path.join(directory, "capture.json"), JSON.stringify(capture));
}, 30000);
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});
async function invoke(args: string[]) {
  try {
    return {
      ...(await exec(process.execPath, [cli, "app-test", ...args], { cwd: directory, timeout: 20000 })),
      code: 0,
    };
  } catch (error) {
    return error as { stdout: string; stderr: string; code: number };
  }
}
describe("application-test CLI", () => {
  it("evaluates captured side-effectful calls with no reachable API, reports all formats and uses stable codes", async () => {
    const result = await invoke(["collection.json", "--capture", "capture.json"]);
    expect(result.code, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.summary.passed).toBe(1);
    expect(result.stdout).not.toContain("source-secret");
    for (const format of ["junit", "html"]) {
      const file = `report.${format}`;
      expect(
        (
          await invoke([
            "collection.json",
            "--capture",
            "capture.json",
            "--format",
            format,
            "--report-file",
            file,
          ])
        ).code,
      ).toBe(0);
      expect(await readFile(path.join(directory, file), "utf8")).not.toContain("source-secret");
      expect(
        (
          await invoke([
            "collection.json",
            "--capture",
            "capture.json",
            "--format",
            format,
            "--report-file",
            file,
          ])
        ).code,
      ).toBe(5);
    }
    const failing = structuredClone(capture);
    failing.entries[0].response.status = 400;
    await writeFile(path.join(directory, "failed.json"), JSON.stringify(failing));
    expect((await invoke(["collection.json", "--capture", "failed.json"])).code).toBe(1);
    expect((await invoke(["collection.json"])).code).toBe(2);
    expect((await invoke(["collection.json", "--capture", "missing.json"])).code).toBe(4);
    await writeFile(path.join(directory, "invalid.json"), "{}");
    expect((await invoke(["collection.json", "--capture", "invalid.json"])).code).toBe(5);
  });
  it("creates only explicitly requested setup and redacted reviewable draft files, protecting existing source", async () => {
    const before = await readdir(directory);
    const setup = await invoke(["setup", "--write-config", "postbox-app-test.json"]);
    expect(setup.code, setup.stderr).toBe(0);
    expect((await readdir(directory)).filter((f) => !before.includes(f))).toEqual(["postbox-app-test.json"]);
    expect((await invoke(["setup", "--write-config", "postbox-app-test.json"])).code).toBe(5);
    const config = { version: 1, collections: ["collection.json"], capture: "capture.json" };
    await writeFile(path.join(directory, "explicit.json"), JSON.stringify(config));
    expect((await invoke(["--config", "explicit.json"])).code).toBe(0);
    const draft = await invoke(["--capture", "capture.json", "--capture-only", "--draft", "draft.json"]);
    expect(draft.code, draft.stderr).toBe(0);
    const content = await readFile(path.join(directory, "draft.json"), "utf8");
    expect(content).not.toContain("source-secret");
    expect(JSON.parse(content).item).toHaveLength(1);
    expect(await readFile(path.join(directory, "capture.json"), "utf8")).toContain("source-secret");
  });
  it("runs only explicit argv commands, rejects stale recordings, and fails a failed command even with passing observations", async () => {
    const recorder = path.join(directory, "recorder.mjs");
    await writeFile(
      recorder,
      `import fs from 'node:fs';fs.writeFileSync(process.env.POSTBOX_CAPTURE,${JSON.stringify(JSON.stringify(capture))});process.exit(Number(process.argv[2]??0));`,
    );
    const args = [
      "collection.json",
      "--capture",
      "command-capture.json",
      "--command",
      JSON.stringify([process.execPath, recorder]),
    ];
    const result = await invoke(args);
    expect(result.code, result.stderr).toBe(0);
    expect((await invoke(args)).code).toBe(5);
    expect(await readFile(path.join(directory, "command-capture.json"), "utf8")).not.toContain(
      "source-secret",
    );
    const failed = await invoke([
      "collection.json",
      "--capture",
      "bad-command.json",
      "--command",
      JSON.stringify([process.execPath, recorder, "9"]),
      "--format",
      "junit",
    ]);
    expect(failed.code, failed.stderr).toBe(1);
    expect(failed.stdout).toContain("<failure");
    expect(
      (await invoke(["collection.json", "--capture", "unused.json", "--command", "echo test"])).code,
    ).toBe(2);
  });
});
