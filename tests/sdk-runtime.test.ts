import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { readSdkDefinition } from "@/core/sdk/source";
import { generateSdk } from "@/core/sdk/generate";
const run = promisify(execFile);
const exec: typeof run = (async (...args: Parameters<typeof run>) => {
  try {
    return await run(...args);
  } catch (error) {
    const e = error as Error & { stdout: string; stderr: string };
    throw new Error(e.message + "\n" + e.stdout + "\n" + e.stderr);
  }
}) as typeof run;
let server: http.Server, base: string, directory: string;
const observed: { url: string; auth: string | undefined }[] = [];
beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "postbox-sdk-runtime-"));
  server = http.createServer((req, res) => {
    observed.push({ url: req.url ?? "", auth: req.headers.authorization });
    const url = new URL(req.url!, "http://localhost");
    res.setHeader("Content-Type", "application/json");
    if (url.pathname === "/bad") {
      res.statusCode = 500;
      res.end('{"error":"fixture"}');
    } else if (url.pathname === "/malformed") res.end("bad json");
    else if (url.pathname === "/redirect") {
      res.statusCode = 302;
      res.setHeader("Location", "/pets/7");
      res.end();
    } else if (url.pathname === "/slow") setTimeout(() => res.end('{"ok":true}'), 100);
    else if (url.pathname === "/pages") {
      const page = Number(url.searchParams.get("page") ?? 1);
      res.end(JSON.stringify({ page, next: page < 3 ? page + 1 : null }));
    } else if (url.pathname === "/echo") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => res.end(body));
    } else res.end(JSON.stringify({ id: 7, name: "Fido", url: req.url, auth: req.headers.authorization }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
});
const response = {
  "200": {
    description: "OK",
    content: {
      "application/json": {
        schema: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
      },
    },
  },
};
const source = {
  openapi: "3.0.3",
  info: { title: "Local API", version: "1.0.0" },
  paths: {
    "/pets/{id}": { get: { operationId: "get_pet", responses: response } },
    "/pages": {
      get: {
        operationId: "list_pets",
        parameters: [{ in: "query", name: "page", schema: { type: "integer" } }],
        responses: response,
      },
    },
    "/echo": {
      post: {
        operationId: "create_pet",
        requestBody: {
          content: {
            "application/json": {
              schema: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
            },
          },
        },
        responses: response,
      },
    },
    ...Object.fromEntries(
      ["bad", "malformed", "redirect", "slow"].map((name) => [
        "/" + name,
        { get: { operationId: name, responses: response } },
      ]),
    ),
  },
};
async function artifact(language: "typescript" | "python") {
  const value = generateSdk(readSdkDefinition(JSON.stringify(source)), {
    language,
    name: "local_client",
    version: "1.0.0",
  });
  const root = path.join(directory, language);
  await mkdir(root, { recursive: true });
  for (const [file, content] of Object.entries(value.files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
  return { ...value, root };
}
describe("generated SDK clients against a local API", () => {
  it("runs the npm client with auth/error/pagination hooks, body and path encoding, timeout and redirect protection", async () => {
    const sdk = await artifact("typescript");
    const clientModule = await import(pathToFileURL(path.join(sdk.root, "client.js")).href);
    const failures: string[] = [];
    const client = new clientModule.Client({
      baseUrl: base,
      auth: async (request: { headers: Record<string, string> }) => {
        request.headers.Authorization = "Bearer runtime-token";
      },
      onError: (error: { kind: string }) => failures.push(error.kind),
    });
    expect(
      (await client.get_pet({ path: { id: "a/b" }, query: { active: false, tags: ["a", "b"] } })).url,
    ).toContain("/pets/a%2Fb");
    expect(observed.at(-1)?.auth).toBe("Bearer runtime-token");
    expect(await client.create_pet({ body: { name: "Fido" } })).toEqual({ name: "Fido" });
    const pages = [];
    for await (const page of client.pages(
      (options: unknown) => client.list_pets(options),
      { query: { page: 1 } },
      (value: { next: number | null }) => (value.next ? { query: { page: value.next } } : null),
    ))
      pages.push(page.page);
    expect(pages).toEqual([1, 2, 3]);
    await expect(client.bad()).rejects.toMatchObject({ kind: "http", status: 500 });
    await expect(client.malformed()).rejects.toMatchObject({ kind: "decode" });
    const before = observed.length;
    await expect(client.redirect()).rejects.toMatchObject({ kind: "http", status: 302 });
    expect(observed.length).toBe(before + 1);
    const timed = new clientModule.Client({ baseUrl: base, timeoutMs: 5 });
    await expect(timed.slow()).rejects.toMatchObject({ kind: "network" });
    expect(failures).toEqual(["http", "decode", "http"]);
    await expect(client.get_pet({ path: { id: "{{id}}" } })).rejects.toThrow(/unresolved/);
    await expect(client.get_pet({ path: Object.create({ id: 7 }) })).rejects.toThrow(/Missing/);
    const npmRoot = path.join(directory, "npm-consumer");
    await mkdir(npmRoot);
    await writeFile(
      path.join(npmRoot, "package.json"),
      JSON.stringify({ name: "fixture", private: true, type: "module" }),
    );
    const archive = path.join(directory, sdk.filename);
    await writeFile(archive, sdk.archive);
    await exec(
      "npm",
      ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", archive],
      { cwd: npmRoot },
    );
    const installed = await exec(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import {Client} from 'local_client'; const value=await new Client({baseUrl:${JSON.stringify(base)}}).get_pet({path:{id:7}}); console.log(value.id);`,
      ],
      { cwd: npmRoot },
    );
    expect(installed.stdout.trim()).toBe("7");
  }, 30000);
  it("installs and runs the Python wheel with typed methods and auth/error/pagination hooks", async () => {
    const sdk = await artifact("python");
    const script = `from local_client import Client, ApiError\nfailures=[]\ndef auth(request):\n    request['headers']['Authorization']='Bearer python-runtime-token'\ndef on_error(error, request):\n    failures.append(error.kind)\napi=Client(${JSON.stringify(base)}, auth=auth, on_error=on_error)\nassert api.get_pet(path={'id':'a/b'})['url'].startswith('/pets/a%2Fb')\nassert api.create_pet(body={'name':'Fido'})=={'name':'Fido'}\npages=list(api.pages(lambda options: api.list_pets(**options), {'query':{'page':1}}, lambda value, previous, index: {'query':{'page':value['next']}} if value['next'] else None))\nassert [value['page'] for value in pages]==[1,2,3]\nfor operation, kind in [(api.bad,'http'),(api.malformed,'decode'),(api.redirect,'http')]:\n    try: operation(); raise AssertionError('expected error')\n    except ApiError as error: assert error.kind==kind\ntry: list(api.pages(lambda options: api.list_pets(**options), {}, lambda value, previous, index: {}, max_pages=2)); raise AssertionError('expected limit')\nexcept ApiError as error: assert error.kind=='pagination'\ntry: Client(${JSON.stringify(base)},timeout=0.005).slow(); raise AssertionError('expected timeout')\nexcept ApiError as error: assert error.kind=='network'\nassert failures==['http','decode','http']\nprint('python-sdk-ok')\n`;
    const archive = path.join(directory, sdk.filename);
    await writeFile(archive, sdk.archive);
    const installed = path.join(directory, "python-installed");
    await exec("python3", [
      "-m",
      "pip",
      "install",
      "--no-index",
      "--no-deps",
      "--target",
      installed,
      archive,
    ]);
    const result = await exec("python3", ["-c", script], { cwd: installed });
    expect(result.stdout.trim()).toBe("python-sdk-ok");
    expect(observed.some((entry) => entry.auth === "Bearer python-runtime-token")).toBe(true);
  }, 30000);
});
