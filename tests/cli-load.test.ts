import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import http from "node:http";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { buildCliBundle } from "./helpers/cli-bundle";
import { parseDuration, profileFromOptions, summaryText } from "../src/cli/load";

const exec = promisify(execFile);
let directory: string;
let cli: string;
let target: http.Server;
let api: http.Server;
let targetUrl = "";
let apiUrl = "";
let hits = 0;
const apiBodies: unknown[] = [];

beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "postbox-cli-load-"));
  cli = await buildCliBundle(directory);
  target = http.createServer((req, res) => {
    hits++;
    setTimeout(() => {
      res.writeHead(req.url === "/bad" ? 500 : 200, { "Content-Type": "text/plain" });
      res.end("ok");
    }, 5);
  });
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  targetUrl = `http://127.0.0.1:${(target.address() as AddressInfo).port}`;

  // A stand-in management API that streams a finished load test.
  api = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (req.headers.authorization !== "Bearer tok") {
        res.writeHead(401, { "Content-Type": "application/json" });
        return res.end('{"error":"Authentication required"}');
      }
      if (req.method === "POST" && req.url === "/api/load-runs") {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        apiBodies.push(body);
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        const status = body.thresholds?.length ? "failed" : "passed";
        res.write(JSON.stringify({ type: "start", runId: "L1" }) + "\n");
        setTimeout(() => {
          res.write(JSON.stringify({ type: "done", runId: "L1", result: { status } }));
          res.end();
        }, 20);
        return;
      }
      if (req.url?.startsWith("/api/load-runs/L1/export")) {
        res.writeHead(200, { "Content-Type": "text/csv" });
        return res.end("section,name,value\n");
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
}, 60000);

afterAll(async () => {
  target?.close();
  api?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function invoke(args: string[], env: Record<string, string> = {}) {
  try {
    const r = await exec(process.execPath, [cli, ...args], {
      cwd: directory,
      env: {
        ...process.env,
        POSTBOX_CONFIG: path.join(directory, "profiles.json"),
        POSTBOX_URL: "",
        POSTBOX_TOKEN: "",
        ...env,
      },
      timeout: 60000,
    });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

const collection = (...paths: string[]) => ({
  info: { name: "Shop", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
  item: paths.map((p) => ({
    name: p === "/" ? "Home" : p.slice(1),
    request: { method: "GET", url: `${targetUrl}${p}` },
  })),
});

describe("load CLI helpers", () => {
  it("parses durations", () => {
    expect(parseDuration("30")).toBe(30);
    expect(parseDuration("45s")).toBe(45);
    expect(parseDuration("2m")).toBe(120);
    expect(parseDuration("1h")).toBe(3600);
    expect(() => parseDuration("0s")).toThrow();
    expect(() => parseDuration("2d")).toThrow();
    expect(() => parseDuration("99h")).toThrow();
  });

  it("builds profiles from flags", () => {
    const base = { stage: [], startVus: 0 };
    expect(profileFromOptions({ ...base })).toEqual({ type: "constant", vus: 1, durationSec: 30 });
    expect(profileFromOptions({ ...base, vus: 8, duration: 90 })).toEqual({
      type: "constant",
      vus: 8,
      durationSec: 90,
    });
    expect(
      profileFromOptions({ ...base, stage: [{ durationSec: 10, target: 5 }], startVus: 1 }),
    ).toMatchObject({ type: "ramp", startVus: 1 });
    expect(
      profileFromOptions({ ...base, vus: 2, spikeVus: 20, duration: 60, spikeAt: 20, spikeFor: 10 }),
    ).toMatchObject({ type: "spike", baseVus: 2, spikeVus: 20, spikeAtSec: 20 });
    expect(() => profileFromOptions({ ...base, vus: 9, spikeVus: 3, duration: 60 })).toThrow(
      /at least baseVus/,
    );
  });

  it("summarises a result", () => {
    const text = summaryText({
      name: "Shop",
      status: "failed",
      stoppedBy: null,
      startedAt: 0,
      finishedAt: 1,
      durationMs: 1,
      profile: { type: "constant", vus: 2, durationSec: 5 },
      warnings: [],
      thresholds: [{ metric: "p95", op: "<", value: 5, label: "p95<5 (ms)", actual: 9, passed: false }],
      snapshot: {
        elapsedSec: 5,
        requests: 10,
        errors: 1,
        errorRate: 0.1,
        rps: 2,
        bytes: 0,
        checksPassed: 0,
        checksFailed: 0,
        checkFailRate: 0,
        latency: { min: 1, avg: 5, p50: 4, p90: 8, p95: 9, p99: 10, max: 11 },
        peakVus: 2,
        statuses: {},
        series: [],
        errorKinds: [{ message: "boom", count: 1 }],
        byRequest: [
          {
            name: "Home",
            requests: 10,
            errors: 1,
            errorRate: 0.1,
            latency: { min: 1, avg: 5, p50: 4, p90: 8, p95: 9, p99: 10, max: 11 },
          },
        ],
      },
    });
    expect(text).toContain("FAIL p95<5 (ms): 9");
    expect(text).toContain("1x boom");
    expect(text).toContain("result     failed");
  });
});

describe("postbox load", () => {
  it("load-tests a collection, prints percentiles and writes a CSV report", async () => {
    const file = path.join(directory, "shop.json");
    await writeFile(file, JSON.stringify(collection("/", "/slow")));
    const out = path.join(directory, "reports", "shop.csv");
    hits = 0;
    const r = await invoke([
      "load",
      file,
      "--vus",
      "3",
      "--duration",
      "2",
      "--think",
      "20",
      "--threshold",
      "p95<5000",
      "--threshold",
      "errorRate<0.01",
      "--out",
      out,
      "--format",
      "csv",
      "-q",
    ]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("Shop: 3 VUs for 2 s");
    expect(r.stdout).toMatch(/requests +\d+ in/);
    expect(r.stdout).toContain("PASS p95<5000");
    expect(r.stdout).toContain("result     passed");
    expect(hits).toBeGreaterThan(5);
    const csv = await readFile(out, "utf8");
    expect(csv).toContain("latency_ms,p95,");
    expect(csv).toContain("t_seconds,requests,errors,rps,p50_ms,p95_ms,vus");
  }, 60000);

  it("exits 1 when a threshold fails and reports the errors", async () => {
    const file = path.join(directory, "bad.json");
    await writeFile(file, JSON.stringify(collection("/bad")));
    const r = await invoke([
      "load",
      file,
      "--vus",
      "2",
      "--duration",
      "1",
      "--threshold",
      "errorRate<0.01",
      "-q",
    ]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("FAIL errorRate<0.01");
    expect(r.stdout).toContain("result     failed");
  }, 60000);

  it("refuses bad flags and profiles over the ceiling without sending anything", async () => {
    const file = path.join(directory, "shop.json");
    hits = 0;
    expect((await invoke(["load", file, "--vus", "5000", "--max-vus", "10", "-q"])).code).toBe(1);
    expect((await invoke(["load", file, "--vus", "0"])).code).not.toBe(0);
    expect((await invoke(["load", file, "--threshold", "nonsense"])).code).not.toBe(0);
    expect((await invoke(["load", file, "--duration", "soon"])).code).not.toBe(0);
    expect((await invoke(["load", path.join(directory, "missing.json")])).code).toBe(2);
    expect(hits).toBe(0);
  }, 60000);
});

describe("postbox load-run", () => {
  const env = () => ({ POSTBOX_URL: apiUrl, POSTBOX_TOKEN: "tok" });

  it("starts a test on the server, waits for the result and maps failure to exit code 1", async () => {
    const passed = await invoke(
      ["load-run", "start", "f1", "-w", "w1", "--vus", "4", "--duration", "10s", "-o", "json"],
      env(),
    );
    expect(passed.code, passed.stderr).toBe(0);
    expect(JSON.parse(passed.stdout)).toMatchObject({ id: "L1", status: "passed" });
    expect(apiBodies.at(-1)).toMatchObject({
      workspaceId: "w1",
      folderId: "f1",
      profile: { type: "constant", vus: 4, durationSec: 10 },
      thresholds: [],
    });
    const failed = await invoke(
      [
        "load-run",
        "start",
        "f1",
        "-w",
        "w1",
        "--stage",
        "5s:3",
        "--stage",
        "5s:0",
        "--threshold",
        "p95<10",
        "-o",
        "json",
      ],
      env(),
    );
    expect(failed.code).toBe(1);
    expect(apiBodies.at(-1)).toMatchObject({
      profile: {
        type: "ramp",
        stages: [
          { durationSec: 5, target: 3 },
          { durationSec: 5, target: 0 },
        ],
      },
    });
    expect(
      (await invoke(["load-run", "start", "f1", "-w", "w1"], { POSTBOX_URL: apiUrl, POSTBOX_TOKEN: "wrong" }))
        .code,
    ).toBe(3);
  }, 60000);

  it("downloads reports", async () => {
    const csv = await invoke(["load-run", "export", "L1", "--format", "csv"], env());
    expect(csv.stdout).toContain("section,name,value");
  }, 60000);
});
