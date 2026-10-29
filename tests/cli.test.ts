import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as XLSX from "xlsx";
import { startTestServer, type TestServer } from "./helpers/server";

const exec = promisify(execFile);
let server: TestServer;
let directory: string;
let cli: string;

beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "postbox-cli-"));
  server = await startTestServer();
  await exec(process.execPath, ["scripts/build-cli.mjs"]);
  await cp(path.resolve("dist"), path.join(directory, "bundle"), { recursive: true });
  cli = path.join(directory, "bundle/cli.mjs");
}, 30000);

afterAll(async () => {
  await server?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function invoke(args: string[], extraEnv: Partial<NodeJS.ProcessEnv> = {}) {
  try {
    const result = await exec(process.execPath, [cli, ...args], {
      cwd: directory,
      env: { ...process.env, PROXY_ALLOW_HOSTS: "", PROXY_DENY_HOSTS: "", ...extraEnv },
      timeout: 15000,
    });
    return { ...result, code: 0 };
  } catch (error) {
    const result = error as Error & { stdout: string; stderr: string; code: number };
    return { stdout: result.stdout, stderr: result.stderr, code: result.code };
  }
}

async function fixture(name: string, value: unknown) {
  const file = path.join(directory, name);
  await writeFile(file, typeof value === "string" ? value : JSON.stringify(value));
  return file;
}

function collection(url: string, script = 'pm.test("status", () => pm.response.to.have.status(200));') {
  return {
    info: { name: "CLI collection" },
    variable: [
      { key: "base", value: server.url },
      { key: "source", value: "collection" },
    ],
    item: [
      {
        name: "Lookup",
        request: { method: "GET", url },
        event: [{ listen: "test", script: { exec: [script] } }],
      },
    ],
  };
}

describe("standalone CLI", () => {
  it("runs CSV iterations with environment/globals and exports JSON, JUnit and HTML", async () => {
    const input = await fixture(
      "collection.json",
      collection(
        "{{base}}/echo?id={{id}}&source={{source}}&global={{global}}",
        'pm.test("row", () => pm.expect(pm.response.json().query.id).to.equal(pm.iterationData.get("id")));' +
          'pm.test("environment", () => pm.expect(pm.response.json().query.source).to.equal("environment"));' +
          'pm.test("global", () => pm.expect(pm.response.json().query.global).to.equal("global-value"));',
      ),
    );
    const environment = await fixture("environment.json", {
      name: "Environment",
      values: [
        { key: "source", value: "environment" },
        { key: "base", value: "http://invalid", enabled: false },
      ],
    });
    const globals = await fixture("globals.json", {
      name: "Globals",
      values: [{ key: "global", value: "global-value" }],
    });
    const data = await fixture("rows.csv", "id\nA-1\nA-2\n");
    const result = await invoke([
      "run",
      input,
      "-e",
      environment,
      "-g",
      globals,
      "-d",
      data,
      "--reporters",
      "cli,json,junit,html",
      "--reporter-junit-export",
      "reports/results.xml",
    ]);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("PASS [1] GET Lookup");
    expect(result.stdout).toContain("PASS [2] GET Lookup");
    expect(result.stdout).toContain("Total  Passed  Failed");
    const report = JSON.parse(await readFile(path.join(directory, "postbox-report.json"), "utf8"));
    expect(report).toMatchObject({ iterations: 2, totalRequests: 2, passedTests: 6, status: "passed" });
    expect(report.results.map((r: { url: string }) => r.url)).toEqual([
      `${server.url}/echo?id=A-1&source=environment&global=global-value`,
      `${server.url}/echo?id=A-2&source=environment&global=global-value`,
    ]);
    const junit = await readFile(path.join(directory, "reports/results.xml"), "utf8");
    expect(junit).toContain('tests="6" failures="0"');
    expect(junit).toContain("[iteration 2]");
    expect(await readFile(path.join(directory, "postbox-report.html"), "utf8")).toContain("<!doctype html>");
  });

  it("exits 1 on assertion failures and honors bail across iterations", async () => {
    const input = collection(`${server.url}/echo`, 'pm.test("bad <&>", () => pm.expect(1).to.equal(2));');
    input.item.push({ name: "Unreached", request: { method: "GET", url: `${server.url}/echo` }, event: [] });
    const file = await fixture("failed.json", input);
    const result = await invoke([
      "run",
      file,
      "-n",
      "4",
      "--bail",
      "--reporters",
      "cli,junit",
      "--reporter-junit-export",
      "failed.xml",
    ]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("FAIL [1] GET Lookup");
    expect(result.stdout).not.toContain("Unreached");
    const xml = await readFile(path.join(directory, "failed.xml"), "utf8");
    expect(xml).toContain('tests="1" failures="1"');
    expect(xml).toContain('name="bad &lt;&amp;&gt;"');
  });

  it("supports JSON/XLSX data and explicit iteration counts with delay", async () => {
    const file = await fixture(
      "data-collection.json",
      collection(
        "{{base}}/echo?id={{id}}",
        'pm.test("data", () => pm.expect(pm.response.json().query.id).to.equal(pm.iterationData.get("id")));',
      ),
    );
    const json = await fixture("data.json", [{ id: "one" }, { id: "two" }]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([{ id: "xlsx" }]), "Rows");
    const xlsx = path.join(directory, "data.xlsx");
    await writeFile(xlsx, XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));
    for (const data of [json, xlsx]) {
      const result = await invoke([
        "run",
        file,
        "-d",
        data,
        "-n",
        "3",
        "--delay",
        "10",
        "--reporters",
        "json",
      ]);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toBe("");
      const report = JSON.parse(await readFile(path.join(directory, "postbox-report.json"), "utf8"));
      expect(report).toMatchObject({ iterations: 3, totalRequests: 3, passedTests: 3 });
      expect(report.durationMs).toBeGreaterThanOrEqual(20);
    }
  });

  it("exits 1 on request timeout, script errors and host policy rejection", async () => {
    const timeout = await fixture("timeout.json", collection(`${server.url}/slow?ms=100`));
    const result = await invoke(["run", timeout, "--timeout", "10"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("FAIL");
    const script = await fixture(
      "script-error.json",
      collection(`${server.url}/echo`, 'throw new Error("broken script");'),
    );
    const scriptResult = await invoke(["run", script]);
    expect(scriptResult.code).toBe(1);
    expect(scriptResult.stdout).toContain("broken script");
    const blocked = await invoke(["run", script], { PROXY_DENY_HOSTS: "127.0.0.1" });
    expect(blocked.code).toBe(1);
    expect(blocked.stdout).toContain("blocked by PROXY_DENY_HOSTS");
  });

  it("redacts secret variables echoed in console output and exported reports", async () => {
    const input = await fixture(
      "secret.json",
      collection(
        "{{base}}/echo?token={{token}}",
        'console.log(pm.response.text()); pm.test("secret", () => { throw new Error(pm.response.json().query.token); });',
      ),
    );
    const env = await fixture("secret-env.json", {
      name: "Secrets",
      values: [{ key: "token", value: "secret-value-123", type: "secret" }],
    });
    const result = await invoke(["run", input, "-e", env, "--reporters", "cli,json,junit,html"]);
    expect(result.code).toBe(1);
    expect(result.stdout).not.toContain("secret-value-123");
    for (const ext of ["json", "xml", "html"]) {
      expect(await readFile(path.join(directory, `postbox-report.${ext}`), "utf8")).not.toContain(
        "secret-value-123",
      );
    }
  });

  it("rejects invalid inputs before execution and provides help/version", async () => {
    const input = await fixture("invalid.json", "{broken");
    const empty = await fixture("empty.json", { info: { name: "Empty" }, item: [] });
    for (const args of [
      ["run", input],
      ["run", "missing.json"],
      ["run", empty],
      ["run", input, "-n", "0"],
      ["run", input, "--delay", "-1"],
      ["run", input, "--timeout", "NaN"],
      ["run", input, "--reporters", "unknown"],
      ["run", input, "--reporter-json-export", "report.json"],
    ]) {
      const result = await invoke(args);
      expect(result.code).toBe(1);
      expect(result.stderr).not.toBe("");
    }
    expect((await invoke(["run", "--help"])).stdout).toContain("--reporter-junit-export");
    expect((await invoke(["--version"])).code).toBe(0);
  });
});
