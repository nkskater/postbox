import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { buildCliBundle } from "./helpers/cli-bundle";
import { DEFAULT_GOVERNANCE, governanceConfig } from "@/core/governance/model";
import { lintGovernance } from "@/core/governance/lint";
const exec = promisify(execFile);
let dir: string, cli: string;
const healthy =
  'openapi: 3.0.3\ninfo: {title: API, version: "1", description: API}\nservers: [{url: https://example.test}]\nsecurity: [{bearer: []}]\ncomponents: {securitySchemes: {bearer: {type: http, scheme: bearer}}}\npaths:\n  /health:\n    get:\n      operationId: health\n      summary: Health\n      responses: {"200": {description: OK}}\n';
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "postbox-gov-cli-"));
  cli = await buildCliBundle(dir);
  await writeFile(path.join(dir, "api.yaml"), healthy);
  await writeFile(path.join(dir, "bad.yaml"), healthy.replace("https://", "http://"));
  await writeFile(path.join(dir, "warning.yaml"), healthy.replace("      summary: Health\n", ""));
}, 30000);
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});
async function invoke(args: string[]) {
  try {
    const result = await exec(process.execPath, [cli, "governance", ...args], {
      cwd: dir,
      timeout: 20000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { ...result, code: 0 };
  } catch (error) {
    return error as Error & { stdout: string; stderr: string; code: number };
  }
}
describe("governance CLI reports and stable exit codes", () => {
  it("matches core reports byte-for-byte and writes deterministic JSON artifacts", async () => {
    const result = await invoke(["lint", "api.yaml", "--json", "--report", "report.json"]);
    expect(result.code, result.stderr).toBe(0);
    const expected = lintGovernance(
      { format: "openapi", entrypoint: "api.yaml", files: [{ path: "api.yaml", content: healthy }] },
      DEFAULT_GOVERNANCE,
    );
    expect(JSON.parse(result.stdout)).toEqual(expected);
    expect(JSON.parse(await readFile(path.join(dir, "report.json"), "utf8"))).toEqual(expected);
    const repeated = await invoke(["lint", "api.yaml", "--json"]);
    expect(repeated.stdout).toBe(result.stdout);
    expect((await invoke(["lint", "api.yaml", "--report", "report.json"])).code).toBe(5);
    expect((await invoke(["lint", "api.yaml", "--report", "report.json", "--overwrite"])).code).toBe(0);
  });
  it("uses 0 for passing or warning-only input, 1 for configured failures, 2 for usage, 4 for missing files and 5 for invalid policies", async () => {
    expect((await invoke(["lint", "bad.yaml", "--json"])).code).toBe(1);
    expect((await invoke(["lint", "warning.yaml"])).code).toBe(0);
    expect((await invoke(["lint", "warning.yaml", "--fail-on", "warning"])).code).toBe(1);
    expect((await invoke(["lint", "api.yaml", "--fail-on", "anything"])).code).toBe(2);
    expect((await invoke(["lint", "missing.yaml"])).code).toBe(4);
    await writeFile(
      path.join(dir, "invalid.json"),
      '{"formatVersion":1,"name":"x","rules":[{"id":"x","message":"x","check":{"kind":"script","value":"process.exit()"}}]}',
    );
    expect((await invoke(["lint", "api.yaml", "--rules", "invalid.json"])).code).toBe(5);
  });
  it("accepts exported source bundles and custom policy exclusions without network resolution", async () => {
    const config = governanceConfig.parse({
      ...DEFAULT_GOVERNANCE,
      exclusions: [
        { ruleId: "secure-servers", file: "api.yaml", path: "/servers/**", reason: "Test fixture" },
      ],
    });
    await writeFile(path.join(dir, "rules.json"), JSON.stringify(config));
    await writeFile(
      path.join(dir, "source.json"),
      JSON.stringify({
        format: "openapi",
        entrypoint: "api.yaml",
        files: [{ path: "api.yaml", content: healthy.replace("https://", "http://") }],
      }),
    );
    const result = await invoke(["lint", "source.json", "--rules", "rules.json", "--json"]);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).summary.excluded).toBe(1);
  });
  it("loads explicitly included files relative to the entrypoint directory", async () => {
    await mkdir(path.join(dir, "nested", "models"), { recursive: true });
    await writeFile(
      path.join(dir, "nested", "api.yaml"),
      healthy.replace(
        'responses: {"200": {description: OK}}',
        'responses: {"200": {$ref: "models/response.yaml#/response"}}',
      ),
    );
    await writeFile(path.join(dir, "nested", "models", "response.yaml"), "response: {description: OK}");
    const result = await invoke(["lint", "nested/api.yaml", "--include", "models/response.yaml", "--json"]);
    expect(result.code, result.stderr).toBe(0);
  });
  it("exports the default policy and rejects malformed source without pretending it passes", async () => {
    const defaults = await invoke(["defaults"]);
    expect(JSON.parse(defaults.stdout)).toEqual(DEFAULT_GOVERNANCE);
    await writeFile(path.join(dir, "malformed.yaml"), "openapi: [broken");
    expect((await invoke(["lint", "malformed.yaml", "--json"])).code).toBe(1);
  });
});

describe("incomplete governance CI results", () => {
  it("uses the stable resource-limit exit code when evaluation cannot complete", async () => {
    const config = governanceConfig.parse({
      formatVersion: 1,
      name: "Bounded",
      rules: [{ id: "required", message: "required", given: "/**/**/**/**/**", check: { kind: "required" } }],
    });
    await writeFile(path.join(dir, "bounded-rules.json"), JSON.stringify(config));
    await writeFile(
      path.join(dir, "large.json"),
      JSON.stringify({
        openapi: "3.0.3",
        info: { title: "x", version: "1" },
        paths: {},
        components: {
          schemas: Object.fromEntries(
            Array.from({ length: 8000 }, (_, i) => [
              "Item" + i,
              { type: "object", properties: { name: { type: "string" } } },
            ]),
          ),
        },
      }),
    );
    const report = await invoke(["lint", "large.json", "--rules", "bounded-rules.json", "--json"]);
    expect(report.code, report.stderr).toBe(6);
    expect(JSON.parse(report.stdout).complete).toBe(false);
  });
});
