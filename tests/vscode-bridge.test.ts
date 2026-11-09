import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isSecretKey, parseDotenv, planDotenvImport, toDotenv } from "../extensions/vscode/src/bridge/dotenv";
import { discover, sendOffline } from "../extensions/vscode/src/bridge/offline";
import { renderResult, summaryOf } from "../extensions/vscode/src/bridge/render";
import { PostboxApiError, ServerBackend, toViewResult } from "../extensions/vscode/src/bridge/server";
import { nodeFiles } from "../extensions/vscode/src/fs-access";
import { writeWorkspaceFixture } from "./helpers/repo-fixture";
import type { Variable } from "../src/core/types";

let root: string;
let target: http.Server;
let base: string;
const seenKeys: (string | undefined)[] = [];
beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-vscode-"));
  target = http.createServer((req, res) => {
    seenKeys.push(req.headers["x-api-key"] as string | undefined);
    res.setHeader("content-type", "application/json");
    if (req.url === "/pets/1") res.end('{"id":1,"name":"Rex"}');
    else {
      res.statusCode = 404;
      res.end('{"error":"no such pet"}');
    }
  });
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(target.address() as AddressInfo).port}`;
  writeWorkspaceFixture(root, base);
});
afterAll(async () => {
  target.closeAllConnections();
  await new Promise<void>((resolve) => target.close(() => resolve()));
  fs.rmSync(root, { recursive: true, force: true });
});

describe(".env handling", () => {
  it("parses the common dialect", () => {
    const entries = parseDotenv(
      [
        "# comment",
        "HOST=api.example.test # trailing",
        "export PORT=8080",
        'QUOTED="a b\\nc"',
        "SINGLE='x # y'",
        "EMPTY=",
        "bad line",
        "HOST=again",
      ].join("\n"),
    );
    expect(Object.fromEntries(entries.map((e) => [e.key, e.value]))).toEqual({
      HOST: "again",
      PORT: "8080",
      QUOTED: "a b\nc",
      SINGLE: "x # y",
      EMPTY: "",
    });
  });

  it("imports without secret values by default and never drops existing variables", () => {
    const existing: Variable[] = [
      { key: "base", value: "keep", type: "default", enabled: true },
      { key: "other", value: "mine", type: "default", enabled: true },
    ];
    const plan = planDotenvImport(existing, parseDotenv("base=new\nAPI_TOKEN=abc123\nNEW=1"));
    expect(plan.added.sort()).toEqual(["API_TOKEN", "NEW"]);
    expect(plan.unchanged).toEqual(["base"]);
    expect(plan.withheld).toEqual(["API_TOKEN"]);
    const token = plan.variables.find((v) => v.key === "API_TOKEN")!;
    expect(token).toMatchObject({ type: "secret", value: "" });
    expect(plan.variables.find((v) => v.key === "other")!.value).toBe("mine");
    expect(JSON.stringify(plan)).not.toContain("abc123");
  });

  it("imports secret values only when asked, can overwrite, and honours per-key overrides", () => {
    const existing: Variable[] = [{ key: "base", value: "old", type: "default", enabled: true }];
    const entries = parseDotenv("base=new\nAPI_TOKEN=abc123\nSESSION=zzz");
    const plan = planDotenvImport(existing, entries, {
      includeSecretValues: true,
      overwrite: true,
      plainKeys: ["SESSION"],
      only: ["base", "API_TOKEN", "SESSION"],
    });
    expect(plan.updated).toEqual(["base"]);
    expect(plan.variables.find((v) => v.key === "API_TOKEN")).toMatchObject({
      type: "secret",
      value: "abc123",
    });
    expect(plan.variables.find((v) => v.key === "SESSION")).toMatchObject({ type: "default", value: "zzz" });
    expect(isSecretKey("CUSTOM", { secretKeys: ["CUSTOM"] })).toBe(true);
  });

  it("exports without secrets unless opted in, and quotes what needs it", () => {
    const variables: Variable[] = [
      { key: "base", value: "https://x.test/a b", type: "default", enabled: true },
      { key: "API_TOKEN", value: "s3cret", type: "secret", enabled: true },
      { key: "off", value: "1", type: "default", enabled: false },
      { key: "PASSWORD_HINT", value: "x", type: "default", enabled: true },
    ];
    const plain = toDotenv(variables);
    expect(plain.text).toBe('base="https://x.test/a b"\n');
    expect(plain.omitted).toEqual(["API_TOKEN", "PASSWORD_HINT"]);
    expect(toDotenv(variables, { includeSecrets: true }).text).toContain("API_TOKEN=s3cret");
  });
});

describe("server backend", () => {
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  it("sends the token as a bearer header and maps errors", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const backend = new ServerBackend({
      baseUrl: "https://postbox.example.test/",
      token: "pbx_secret",
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return url.endsWith("/api/workspaces")
          ? reply(200, [{ id: "w1", name: "Home" }])
          : reply(401, { error: "Authentication required" });
      }) as typeof fetch,
    });
    expect(await backend.workspaces()).toEqual([{ id: "w1", name: "Home" }]);
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer pbx_secret");
    expect(calls[0].url).toBe("https://postbox.example.test/api/workspaces");
    await expect(backend.tree("w1")).rejects.toMatchObject({
      status: 401,
      message: expect.stringContaining("Set API Token"),
    });
    await expect(backend.tree("w1")).rejects.toBeInstanceOf(PostboxApiError);
  });

  it("rejects a server URL that is not http(s) and omits the header without a token", async () => {
    expect(() => new ServerBackend({ baseUrl: "ftp://x", token: null })).toThrow(/http/);
    let headers: Record<string, string> = {};
    const backend = new ServerBackend({
      baseUrl: "http://localhost:3000",
      token: null,
      fetch: (async (_u: string, init: RequestInit) => {
        headers = init.headers as Record<string, string>;
        return reply(200, []);
      }) as typeof fetch,
    });
    await backend.workspaces();
    expect(headers.authorization).toBeUndefined();
  });

  it("normalises a proxy result", () => {
    const view = toViewResult(
      { name: "Get pet", method: "GET", url: "{{base}}/pets" },
      {
        response: {
          status: 200,
          statusText: "OK",
          headers: [["content-type", "application/json"]],
          bodyText: '{"a":1}',
          size: 7,
          url: "http://x/pets",
          timings: { total: 12.4 },
        },
        tests: [{ name: "ok", passed: true }],
        logs: [{ level: "log", message: "hi" }],
      },
    );
    expect(view).toMatchObject({ status: 200, url: "http://x/pets", timeMs: 12.4, body: '{"a":1}' });
    expect(summaryOf(view)).toBe("200 OK · 12 ms · 1 tests passed");
  });
});

describe("rendering", () => {
  it("shows status, tests, a pretty response and console output", () => {
    const text = renderResult({
      name: "Get pet",
      method: "GET",
      url: "http://x/pets/1",
      status: 200,
      statusText: "OK",
      timeMs: 20,
      size: 20,
      headers: [["content-type", "application/json"]],
      body: '{"id":1}',
      tests: [
        { name: "found", passed: true },
        { name: "named", passed: false, error: "expected Rex" },
      ],
      logs: [{ level: "log", message: "hello" }],
      error: null,
      warnings: ["3 variables unresolved"],
    });
    expect(text).toContain("**200 OK** · 20 ms · 20 B");
    expect(text).toContain("## Tests (1/2 passed)");
    expect(text).toContain("✗ named — expected Rex");
    expect(text).toContain('"id": 1');
    expect(text).toContain("- log: hello");
    expect(text).toContain("> 3 variables unresolved");
  });
  it("shows a failure plainly", () => {
    const text = renderResult({
      name: "x",
      method: "GET",
      url: "u",
      status: null,
      statusText: "",
      timeMs: null,
      size: null,
      headers: [],
      body: "",
      tests: [],
      logs: [],
      error: "ECONNREFUSED",
      warnings: [],
    });
    expect(text).toContain("**Failed:** ECONNREFUSED");
    expect(text).not.toContain("## Response");
  });
});

describe("offline repository directories", () => {
  it("finds collections and environments and reports a broken directory without failing", async () => {
    fs.mkdirSync(path.join(root, "broken"));
    fs.writeFileSync(path.join(root, "broken", "collection.json"), "{ not json");
    const found = await discover(nodeFiles, root);
    expect(found.collections.map((c) => [c.dir, c.name])).toEqual([["api/pets", "Pets"]]);
    expect(
      found.collections[0].root.children.map((c) => [c.name, c.method, c.file?.endsWith(".request.json")]),
    ).toEqual([
      ["Get pet", "GET", true],
      ["Missing pet", "GET", true],
    ]);
    expect(found.environments).toMatchObject([{ dir: "api/staging", name: "Staging" }]);
    expect(found.problems.map((p) => p.dir)).toEqual(["broken"]);
    fs.rmSync(path.join(root, "broken"), { recursive: true });
  });

  it("sends a request with the engine, runs its tests and uses local secret values", async () => {
    const ok = await sendOffline(nodeFiles, root, {
      collectionDir: "api/pets",
      requestId: "req1",
      environmentDir: "api/staging",
      localVariables: { apiKey: "from-dotenv-1234" },
    });
    expect(ok).toMatchObject({ status: 200, name: "Get pet", error: null });
    expect(ok.body).toContain("Rex");
    expect(ok.tests).toEqual([
      expect.objectContaining({ name: "found", passed: true }),
      expect.objectContaining({ name: "is a pet", passed: true }),
    ]);
    expect(seenKeys.at(-1)).toBe("from-dotenv-1234");
    expect(JSON.stringify(ok)).not.toContain("from-dotenv-1234");

    const missing = await sendOffline(nodeFiles, root, {
      collectionDir: "api/pets",
      requestId: "req2",
      environmentDir: "api/staging",
    });
    expect(missing.status).toBe(404);
    expect(missing.tests[0]).toMatchObject({ name: "missing", passed: false });
  });

  it("enforces host rules and reports an unknown request", async () => {
    const denied = await sendOffline(nodeFiles, root, {
      collectionDir: "api/pets",
      requestId: "req1",
      environmentDir: "api/staging",
      denyHosts: ["127.0.0.1"],
    });
    expect(denied.status).toBeNull();
    expect(denied.error).toMatch(/blocked|denied|not allowed|policy/i);
    await expect(
      sendOffline(nodeFiles, root, { collectionDir: "api/pets", requestId: "nope" }),
    ).rejects.toThrow(/not found/);
  });
});
