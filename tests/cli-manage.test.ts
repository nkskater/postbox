import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import http from "node:http";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { buildCliBundle } from "./helpers/cli-bundle";
import { paginate, renderTable, column } from "../src/cli/output";
import { exitCodeForStatus } from "../src/cli/errors";
import { maskToken, normalizeServerUrl } from "../src/cli/profiles";

const exec = promisify(execFile);
const TOKEN = "pbx_test_token_value";
let directory: string;
let cli: string;
let server: http.Server;
let base: string;
const seen: { method: string; url: string; auth?: string; body: string }[] = [];

/** A deterministic stand-in for the management API: fixed ids, no database. */
function handler(req: http.IncomingMessage, res: http.ServerResponse) {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body });
    const reply = (status: number, value: unknown, type = "application/json") => {
      res.writeHead(status, { "Content-Type": type });
      res.end(typeof value === "string" ? value : JSON.stringify(value));
    };
    const url = new URL(req.url!, "http://localhost");
    if (req.headers.authorization !== `Bearer ${TOKEN}`)
      return reply(401, { error: "Authentication required" });
    const route = `${req.method} ${url.pathname}`;
    switch (route) {
      case "GET /api/workspaces":
        return reply(200, [
          { id: "w1", name: "One" },
          { id: "w2", name: "Two" },
          { id: "w3", name: "Three" },
        ]);
      case "POST /api/workspaces":
        return reply(201, { id: "w9", ...JSON.parse(body) });
      case "DELETE /api/workspaces/w1":
        return reply(200, { ok: true });
      case "GET /api/workspaces/w1/tree":
        return reply(200, {
          folders: [
            { id: "c1", parentId: null, name: "Pets" },
            { id: "f1", parentId: "c1", name: "Dogs" },
          ],
          requests: [{ id: "r1", folderId: "f1", name: "List dogs", method: "GET" }],
        });
      case "POST /api/folders":
        return reply(201, { id: "c2", ...JSON.parse(body) });
      case "GET /api/export/collection/c1":
        return reply(200, '{"info":{"name":"Pets"}}');
      case "GET /api/environments":
        return reply(200, [{ id: "e1", name: "Staging", workspaceId: url.searchParams.get("workspaceId") }]);
      case "PATCH /api/environments/e1":
        return reply(200, { id: "e1", ...JSON.parse(body) });
      case "GET /api/environments/missing":
        return reply(404, { error: "Environment not found" });
      case "PUT /api/variables":
        return reply(200, JSON.parse(body).variables);
      case "POST /api/import":
        return reply(201, { kind: "imported", received: JSON.parse(body) });
      case "GET /api/mocks":
        return reply(200, [
          { id: "m1", name: "Pets mock", workspaceId: url.searchParams.get("workspaceId") },
        ]);
      case "GET /api/mocks/m1/logs":
        return reply(200, [{ id: "l1", method: "GET", path: "/pets", status: 200 }]);
      case "POST /api/mocks/m1/reset":
        return reply(200, { ok: true });
      case "DELETE /api/mocks/m1":
        return reply(200, { ok: true });
      case "GET /api/limited":
        return reply(429, { error: "Rate limit exceeded" });
    }
    return reply(404, { error: "Not found" });
  });
}

beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "postbox-cli-manage-"));
  server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cli = await buildCliBundle(directory);
}, 60000);

afterAll(async () => {
  await new Promise((resolve) => server?.close(resolve));
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function invoke(args: string[], env: Record<string, string> = {}, input?: string) {
  const child = exec(process.execPath, [cli, ...args], {
    cwd: directory,
    env: {
      ...process.env,
      POSTBOX_CONFIG: path.join(directory, "profiles.json"),
      POSTBOX_URL: "",
      POSTBOX_TOKEN: "",
      POSTBOX_PROFILE: "",
      POSTBOX_WORKSPACE: "",
      ...env,
    },
    timeout: 20000,
  });
  if (input !== undefined) child.child.stdin?.end(input);
  try {
    return { ...(await child), code: 0 };
  } catch (error) {
    const failed = error as Error & { stdout: string; stderr: string; code: number };
    return { stdout: failed.stdout, stderr: failed.stderr, code: failed.code };
  }
}
const authed = () => ({ POSTBOX_URL: base, POSTBOX_TOKEN: TOKEN });

describe("management helpers", () => {
  it("pages lists and reports the total", () => {
    const rows = [1, 2, 3, 4, 5].map((n) => ({ n }));
    expect(paginate(rows, { limit: 2, offset: 1 })).toEqual({
      items: [{ n: 2 }, { n: 3 }],
      total: 5,
      offset: 1,
      limit: 2,
    });
    expect(paginate(rows, { offset: 4 }).items).toEqual([{ n: 5 }]);
  });

  it("aligns table columns and flattens whitespace", () => {
    const text = renderTable([{ id: "a", name: "x\ny" }], [column("ID", "id"), column("NAME", "name")]);
    expect(text.split("\n")).toEqual(["ID  NAME", "a   x y"]);
  });

  it("maps HTTP statuses to stable exit codes", () => {
    expect([401, 403, 404, 429, 400, 409, 500].map(exitCodeForStatus)).toEqual([3, 3, 4, 6, 5, 5, 7]);
  });

  it("validates server URLs and masks tokens", () => {
    expect(normalizeServerUrl("https://example.com/base/?x=1#y")).toBe("https://example.com/base");
    expect(() => normalizeServerUrl("ftp://example.com")).toThrow();
    expect(() => normalizeServerUrl("https://user:pw@example.com")).toThrow();
    expect(maskToken(TOKEN)).not.toContain("token_value");
    expect(maskToken("short")).toBe("****");
  });
});

describe("postbox management commands", () => {
  it("lists workspaces as paged JSON with the bearer token", async () => {
    seen.length = 0;
    const result = await invoke(
      ["workspace", "list", "--limit", "2", "--offset", "1", "-o", "json"],
      authed(),
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      items: [
        { id: "w2", name: "Two" },
        { id: "w3", name: "Three" },
      ],
      total: 3,
      offset: 1,
      limit: 2,
    });
    expect(seen[0].auth).toBe(`Bearer ${TOKEN}`);
  });

  it("renders a table when asked", async () => {
    const result = await invoke(["workspace", "list", "-o", "table"], authed());
    expect(result.stdout.split("\n")[0]).toMatch(/^ID\s+NAME$/);
    expect(result.stdout).toContain("Three");
  });

  it("reports auth, not-found and rate-limit failures with distinct exit codes", async () => {
    expect((await invoke(["workspace", "list"], { POSTBOX_URL: base, POSTBOX_TOKEN: "wrong" })).code).toBe(3);
    const missing = await invoke(["env", "get", "missing"], authed());
    expect(missing.code).toBe(4);
    expect(missing.stderr).toContain("Environment not found");
    expect(
      (await invoke(["workspace", "list"], { POSTBOX_URL: "http://127.0.0.1:9", POSTBOX_TOKEN: TOKEN })).code,
    ).toBe(8);
  });

  it("requires a configured server", async () => {
    const result = await invoke(["workspace", "list"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("No server configured");
  });

  it("uses stable usage errors for unknown options", async () => {
    expect((await invoke(["workspace", "list", "--bogus"], authed())).code).toBe(2);
    expect((await invoke(["workspace", "list", "--limit", "0"], authed())).code).toBe(2);
  });

  it("refuses to delete without --yes when not interactive", async () => {
    seen.length = 0;
    const refused = await invoke(["workspace", "delete", "w1"], authed());
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain("--yes");
    expect(seen.some((entry) => entry.method === "DELETE")).toBe(false);
    const confirmed = await invoke(["workspace", "delete", "w1", "--yes"], authed());
    expect(confirmed.code).toBe(0);
    expect(seen.some((entry) => entry.method === "DELETE" && entry.url === "/api/workspaces/w1")).toBe(true);
  });

  it("lists collections, folders and requests from the workspace tree", async () => {
    const env = { ...authed(), POSTBOX_WORKSPACE: "w1" };
    const collections = JSON.parse((await invoke(["collection", "list", "-o", "json"], env)).stdout);
    expect(collections.items.map((item: { id: string }) => item.id)).toEqual(["c1"]);
    const folders = JSON.parse((await invoke(["folder", "list", "-o", "json"], env)).stdout);
    expect(folders.items.map((item: { id: string }) => item.id)).toEqual(["f1"]);
    const requests = JSON.parse(
      (await invoke(["request", "list", "--folder", "f1", "-w", "w1", "-o", "json"], authed())).stdout,
    );
    expect(requests.items).toEqual([{ id: "r1", folderId: "f1", name: "List dogs", method: "GET" }]);
  });

  it("asks for a workspace when several exist", async () => {
    const result = await invoke(["collection", "list"], authed());
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--workspace");
  });

  it("creates assets and sends JSON bodies read from files and stdin", async () => {
    seen.length = 0;
    const created = await invoke(["collection", "create", "Cats", "-w", "w1", "-o", "json"], authed());
    expect(JSON.parse(created.stdout)).toMatchObject({
      id: "c2",
      name: "Cats",
      workspaceId: "w1",
      parentId: null,
    });

    const file = path.join(directory, "vars.json");
    await writeFile(file, JSON.stringify([{ key: "host", value: "a" }]));
    const update = await invoke(
      ["env", "update", "e1", "--name", "Prod", "-f", file, "-o", "json"],
      authed(),
    );
    expect(JSON.parse(update.stdout)).toMatchObject({
      name: "Prod",
      variables: [{ key: "host", value: "a" }],
    });

    const globals = await invoke(
      ["globals", "set", "-w", "w1", "-f", "-", "-o", "json"],
      authed(),
      JSON.stringify([{ key: "g", value: "1" }]),
    );
    expect(JSON.parse(globals.stdout)).toEqual([{ key: "g", value: "1" }]);
    const put = seen.find((entry) => entry.method === "PUT")!;
    expect(JSON.parse(put.body)).toMatchObject({ workspaceId: "w1", scope: "global" });

    const bad = await invoke(["env", "update", "e1", "-f", "-"], authed(), "not json");
    expect(bad.code).toBe(2);
  });

  it("exports to a file or standard output and imports a file", async () => {
    const target = path.join(directory, "pets.json");
    const exported = await invoke(["collection", "export", "c1", "--out", target], authed());
    expect(exported.code).toBe(0);
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual({ info: { name: "Pets" } });
    expect((await invoke(["collection", "export", "c1"], authed())).stdout).toContain('"Pets"');

    const source = path.join(directory, "in.json");
    await writeFile(source, '{"info":{"name":"X"}}');
    const imported = JSON.parse(
      (await invoke(["import", source, "-w", "w1", "-o", "json"], authed())).stdout,
    );
    expect(imported.received).toEqual({ workspaceId: "w1", content: '{"info":{"name":"X"}}' });
  });

  it("inspects and manages mock servers", async () => {
    seen.length = 0;
    const list = JSON.parse((await invoke(["mock", "list", "-w", "w1", "-o", "json"], authed())).stdout);
    expect(list.items).toEqual([{ id: "m1", name: "Pets mock", workspaceId: "w1" }]);
    const logs = JSON.parse((await invoke(["mock", "logs", "m1", "-o", "json"], authed())).stdout);
    expect(logs.items[0]).toMatchObject({ path: "/pets", status: 200 });
    expect((await invoke(["mock", "reset", "m1"], authed())).code).toBe(0);
    expect((await invoke(["mock", "delete", "m1"], authed())).code).toBe(2);
    expect((await invoke(["mock", "delete", "m1", "-y"], authed())).code).toBe(0);
    expect(seen.filter((entry) => entry.method === "DELETE")).toHaveLength(1);
  });

  it("stores profiles privately and masks tokens when listing", async () => {
    const add = await invoke(["profile", "add", "dev", base, "--token", TOKEN]);
    expect(add.code).toBe(0);
    if (process.platform !== "win32")
      expect((await stat(path.join(directory, "profiles.json"))).mode & 0o777).toBe(0o600);
    const listed = await invoke(["profile", "list", "-o", "json"]);
    expect(listed.stdout).not.toContain(TOKEN);
    expect(JSON.parse(listed.stdout).items[0]).toMatchObject({ name: "dev", current: true });

    const viaProfile = await invoke(["workspace", "list", "-o", "json"]);
    expect(viaProfile.code).toBe(0);
    expect(JSON.parse(viaProfile.stdout).total).toBe(3);
  });

  it("can read a profile token from the environment instead of storing it", async () => {
    await invoke(["profile", "add", "ci", base, "--token-env", "CI_POSTBOX_TOKEN", "--default"]);
    const stored = JSON.parse(await readFile(path.join(directory, "profiles.json"), "utf8"));
    expect(stored.profiles.ci).toEqual({ url: base, tokenEnv: "CI_POSTBOX_TOKEN" });
    const result = await invoke(["workspace", "list", "-o", "json"], { CI_POSTBOX_TOKEN: TOKEN });
    expect(result.code).toBe(0);
    expect((await invoke(["workspace", "list"], {})).code).toBe(3);
    expect((await invoke(["profile", "remove", "nope"])).code).toBe(2);
    expect((await invoke(["profile", "add", "bad", "https://u:p@example.com"])).code).toBe(2);
  });

  it("keeps `run` available alongside management commands", async () => {
    const result = await invoke(["--help"]);
    expect(result.stdout).toContain("run");
    expect(result.stdout).toContain("workspace");
    expect(result.stdout).toContain("Exit codes");
  });
});
