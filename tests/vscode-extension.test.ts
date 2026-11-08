import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { activate } from "../extensions/vscode/src/extension";
import { fake } from "./helpers/fake-vscode";
import { writeWorkspaceFixture } from "./helpers/repo-fixture";

type Fake = typeof fake;
const f = fake as Fake;

function context() {
  const secrets = new Map<string, string>();
  const state = new Map<string, unknown>();
  return {
    subscriptions: [] as { dispose(): void }[],
    secrets: {
      get: async (key: string) => secrets.get(key),
      store: async (key: string, value: string) => void secrets.set(key, value),
      delete: async (key: string) => void secrets.delete(key),
    },
    workspaceState: {
      get: (key: string) => state.get(key),
      update: async (key: string, value: unknown) => void state.set(key, value),
    },
    _secrets: secrets,
  };
}
const run = (id: string, ...args: unknown[]) => f.commands.get(id)!(...args);

/** A server double that records requests and answers the few endpoints the extension uses. */
function serverDouble() {
  const calls: { method: string; url: string; auth: string | null; body: unknown }[] = [];
  const environment = {
    id: "e1",
    name: "Staging",
    workspaceId: "w1",
    variables: [{ key: "base", value: "http://x", type: "default", enabled: true }],
  };
  const saved: Record<string, unknown> = {};
  const fetchStub = vi.fn(async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({
      method: init.method ?? "GET",
      url: u.pathname + u.search,
      auth: (init.headers as Record<string, string>).authorization ?? null,
      body,
    });
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
    if (u.pathname === "/api/workspaces") return json([{ id: "w1", name: "Home" }]);
    if (u.pathname === "/api/workspaces/w1/tree")
      return json({
        folders: [
          { id: "f1", parentId: null, name: "Pets" },
          { id: "f2", parentId: "f1", name: "Admin" },
        ],
        requests: [
          { id: "r1", folderId: "f1", name: "List pets", method: "GET" },
          { id: "r2", folderId: "f2", name: "Drop db", method: "DELETE" },
        ],
      });
    if (u.pathname === "/api/environments" && init.method !== "POST")
      return json([{ id: "e1", name: "Staging" }]);
    if (u.pathname === "/api/environments/e1" && init.method === "PATCH") {
      Object.assign(saved, body);
      return json({ ...environment, ...body });
    }
    if (u.pathname === "/api/environments/e1") return json(environment);
    if (u.pathname === "/api/requests/r1" && init.method === "PATCH") {
      saved.request = body;
      return json({ ok: true });
    }
    if (u.pathname === "/api/requests/r1")
      return json({
        id: "r1",
        name: "List pets",
        method: "GET",
        url: "{{base}}/pets",
        folderId: "f1",
        workspaceId: "w1",
        params: [],
        headers: [],
        body: { mode: "none" },
        auth: { type: "inherit" },
        preRequestScript: "",
        testScript: "",
        description: "",
        examples: [],
      });
    if (u.pathname === "/api/proxy")
      return json({
        response: {
          status: 200,
          statusText: "OK",
          headers: [["content-type", "application/json"]],
          bodyText: '{"pets":[]}',
          size: 11,
          url: "http://x/pets",
          timings: { total: 8 },
        },
        tests: [{ name: "has pets", passed: true }],
        logs: [],
      });
    return json({ error: "not found" }, 404);
  });
  return { calls, saved, fetchStub };
}

beforeEach(() => {
  f.reset();
  f.settings = { mode: "server", serverUrl: "http://postbox.test" };
});
afterEach(() => vi.unstubAllGlobals());

describe("extension host: server mode", () => {
  it("registers its commands, views and providers", () => {
    const ctx = context();
    activate(ctx as never);
    expect([...f.commands.keys()].sort()).toEqual(
      [
        "postbox.exportDotenv",
        "postbox.importDotenv",
        "postbox.openItem",
        "postbox.refresh",
        "postbox.selectEnvironment",
        "postbox.send",
        "postbox.setServer",
        "postbox.setToken",
        "postbox.switchMode",
      ].sort(),
    );
    expect(f.views.has("postbox.explorer")).toBe(true);
    expect(f.fileSystems.has("postbox")).toBe(true);
    expect(f.contentProviders.has("postbox-result")).toBe(true);
  });

  it("keeps the token in secret storage and sends it with every call", async () => {
    const server = serverDouble();
    vi.stubGlobal("fetch", server.fetchStub);
    const ctx = context();
    const { tree } = activate(ctx as never);
    f.inputs.push("pbx_token_value");
    await run("postbox.setToken");
    expect(ctx._secrets.get("postbox.token")).toBe("pbx_token_value");
    expect(JSON.stringify(f.settings)).not.toContain("pbx_token_value");
    const workspaces = await tree.getChildren();
    expect(workspaces).toMatchObject([{ kind: "workspace", ws: { name: "Home" } }]);
    expect(server.calls[0]).toMatchObject({ url: "/api/workspaces", auth: "Bearer pbx_token_value" });
    f.inputs.push("");
    await run("postbox.setToken");
    expect(ctx._secrets.has("postbox.token")).toBe(false);
  });

  it("browses workspaces, collections, folders, requests and environments", async () => {
    vi.stubGlobal("fetch", serverDouble().fetchStub);
    const { tree } = activate(context() as never);
    const [workspace] = await tree.getChildren();
    const [collections, environments] = await tree.getChildren(workspace);
    const top = await tree.getChildren(collections);
    expect(top.map((i) => i.kind)).toEqual(["folder"]);
    const inside = await tree.getChildren(top[0]);
    expect(inside.map((i) => [i.kind, "name" in i ? i.name : ""])).toEqual([
      ["folder", "Admin"],
      ["request", "List pets"],
    ]);
    expect((await tree.getChildren(environments)).map((i) => ("name" in i ? i.name : ""))).toEqual([
      "Staging",
    ]);
    const item = tree.getTreeItem(inside[1]);
    expect(item).toMatchObject({ label: "List pets", description: "GET", contextValue: "request" });
  });

  it("edits requests and environments through the postbox: file system", async () => {
    const server = serverDouble();
    vi.stubGlobal("fetch", server.fetchStub);
    activate(context() as never);
    const provider = f.fileSystems.get("postbox")!;
    const doc = JSON.parse(
      Buffer.from(
        await provider.readFile(vscode.Uri.parse("postbox:/w1/request/r1.request.json")),
      ).toString(),
    );
    expect(doc).toMatchObject({ id: "r1", url: "{{base}}/pets" });
    expect(doc.workspaceId).toBeUndefined();
    doc.url = "{{base}}/pets?limit=5";
    await provider.writeFile(
      vscode.Uri.parse("postbox:/w1/request/r1.request.json"),
      Buffer.from(JSON.stringify(doc)),
    );
    expect(server.saved.request).toMatchObject({ url: "{{base}}/pets?limit=5" });
    await expect(
      provider.writeFile(vscode.Uri.parse("postbox:/w1/request/r1.request.json"), Buffer.from("{ nope")),
    ).rejects.toThrow(/Not valid JSON/);
    await provider.writeFile(
      vscode.Uri.parse("postbox:/w1/environment/e1.environment.json"),
      Buffer.from(
        JSON.stringify({
          name: "Staging",
          variables: [{ key: "a", value: "1", type: "default", enabled: true }],
        }),
      ),
    );
    expect(server.saved).toMatchObject({ variables: [{ key: "a" }] });
  });

  it("sends the request open in the editor with its unsaved edits and shows tests and response", async () => {
    const server = serverDouble();
    vi.stubGlobal("fetch", server.fetchStub);
    const ctx = context();
    activate(ctx as never);
    await ctx.workspaceState.update("postbox.environment", "e1");
    const edited = {
      id: "r1",
      name: "List pets",
      method: "GET",
      url: "{{base}}/pets?edited=1",
      params: [],
      headers: [],
    };
    f.activeEditor = {
      document: {
        uri: vscode.Uri.parse("postbox:/w1/request/r1.request.json"),
        getText: () => JSON.stringify(edited),
        save: async () => true,
      },
    };
    await run("postbox.send");
    const proxy = server.calls.find((c) => c.url === "/api/proxy")!;
    expect(proxy.body).toMatchObject({
      workspaceId: "w1",
      environmentId: "e1",
      requestId: "r1",
      folderId: "f1",
      request: { url: "{{base}}/pets?edited=1" },
    });
    const shown = f.shown.at(-1)!;
    expect(shown.scheme).toBe("postbox-result");
    expect(shown.text).toContain("**200 OK**");
    expect(shown.text).toContain("✓ has pets");
    expect(f.status.text).toContain("200 OK");
  });

  it("explains instead of failing silently when nothing is selected or the server rejects", async () => {
    vi.stubGlobal("fetch", serverDouble().fetchStub);
    activate(context() as never);
    await run("postbox.send");
    expect(f.messages.at(-1)).toMatchObject({
      level: "error",
      text: expect.stringContaining("Select a request"),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "x" }), { status: 401 })),
    );
    await run("postbox.refresh");
    const { tree } = activate(context() as never);
    const children = await tree.getChildren();
    expect(children[0]).toMatchObject({ kind: "message" });
    expect(f.messages.some((m) => m.text.includes("Set API Token"))).toBe(true);
  });

  it("imports .env into an environment: secret values stay home unless chosen", async () => {
    const server = serverDouble();
    vi.stubGlobal("fetch", server.fetchStub);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-dotenv-"));
    fs.writeFileSync(path.join(dir, ".env"), "HOST=api.test\nAPI_TOKEN=very-secret-value\n");
    f.folders = [{ uri: { fsPath: dir } }];
    activate(context() as never);
    f.picks.push(
      (items) => items,
      (items) => items[0],
    );
    await run("postbox.importDotenv", {
      kind: "environment",
      ws: { id: "w1", name: "Home" },
      id: "e1",
      name: "Staging",
    });
    const patch = server.calls.find((c) => c.method === "PATCH")!;
    expect(JSON.stringify(patch.body)).not.toContain("very-secret-value");
    expect(patch.body).toMatchObject({
      variables: expect.arrayContaining([
        expect.objectContaining({ key: "API_TOKEN", type: "secret", value: "" }),
        expect.objectContaining({ key: "HOST", value: "api.test" }),
      ]),
    });
    expect(f.messages.at(-1)!.text).toMatch(/1 secret value\(s\) not imported/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("exports an environment to .env without secrets unless the user agrees", async () => {
    const server = serverDouble();
    vi.stubGlobal("fetch", server.fetchStub);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-dotenv-"));
    f.folders = [{ uri: { fsPath: dir } }];
    f.settings.dotenvPath = ".env.local";
    activate(context() as never);
    const withSecret = vi.fn(async (input: string) => {
      if (input.endsWith("/api/environments/e1"))
        return new Response(
          JSON.stringify({
            id: "e1",
            name: "Staging",
            workspaceId: "w1",
            variables: [
              { key: "host", value: "h", type: "default", enabled: true },
              { key: "token", value: "s3", type: "secret", enabled: true },
            ],
          }),
        );
      return server.fetchStub(input, {});
    });
    vi.stubGlobal("fetch", withSecret);
    f.warnings.push("Skip secrets");
    await run("postbox.exportDotenv", {
      kind: "environment",
      ws: { id: "w1", name: "Home" },
      id: "e1",
      name: "Staging",
    });
    expect(fs.readFileSync(path.join(dir, ".env.local"), "utf8")).toBe("host=h\n");
    f.warnings.push("Include secrets");
    await run("postbox.exportDotenv", {
      kind: "environment",
      ws: { id: "w1", name: "Home" },
      id: "e1",
      name: "Staging",
    });
    expect(fs.readFileSync(path.join(dir, ".env.local"), "utf8")).toContain("token=s3");
    if (process.platform !== "win32") expect(fs.statSync(path.join(dir, ".env.local")).mode & 0o077).toBe(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("extension host: offline mode", () => {
  let dir: string;
  let target: http.Server;
  const keys: (string | undefined)[] = [];
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-offline-"));
    target = http.createServer((req, res) => {
      keys.push(req.headers["x-api-key"] as string | undefined);
      res.setHeader("content-type", "application/json");
      res.end('{"id":1,"name":"Rex"}');
    });
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    writeWorkspaceFixture(dir, `http://127.0.0.1:${(target.address() as AddressInfo).port}`);
    fs.writeFileSync(path.join(dir, ".env"), "apiKey=dotenv-key-9999\n");
  });
  afterAll(async () => {
    target.closeAllConnections();
    await new Promise<void>((resolve) => target.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(() => {
    f.settings = { mode: "offline", dotenvPath: ".env" };
    f.folders = [{ uri: { fsPath: dir } }];
  });

  it("lists repository directories and sends a request with secrets from .env", async () => {
    const ctx = context();
    const { tree } = activate(ctx as never);
    const groups = await tree.getChildren();
    expect(groups.map((g) => g.kind)).toEqual(["offline-group", "offline-group"]);
    const [collection] = await tree.getChildren(groups[0]);
    const [first] = await tree.getChildren(collection);
    expect(first).toMatchObject({ kind: "offline-request", node: { name: "Get pet" } });
    const [env] = await tree.getChildren(groups[1]);
    f.picks.push((items) => items.find((i) => i.label === "Staging"));
    await run("postbox.selectEnvironment");
    expect(ctx.workspaceState.get("postbox.environment")).toBe("api/staging");
    await run("postbox.send", first);
    expect(f.shown.at(-1)!.text).toContain("**200 OK**");
    expect(f.shown.at(-1)!.text).toContain("✓ is a pet");
    expect(keys.at(-1)).toBe("dotenv-key-9999");
    expect(f.shown.at(-1)!.text).not.toContain("dotenv-key-9999");
    expect(env).toMatchObject({ kind: "offline-env", name: "Staging" });
  });

  it("sends the request file that is open in the editor", async () => {
    activate(context() as never);
    const file = path.join(
      dir,
      "api/pets",
      fs.readdirSync(path.join(dir, "api/pets")).find((n) => n.startsWith("get-pet"))!,
    );
    f.activeEditor = { document: { uri: vscode.Uri.file(file), getText: () => "", save: async () => true } };
    await run("postbox.send");
    expect(f.shown.at(-1)!.text).toContain("Get pet");
  });

  it("explains when there is nothing to work on", async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-empty-"));
    f.folders = [{ uri: { fsPath: empty } }];
    const { tree } = activate(context() as never);
    expect(await tree.getChildren()).toMatchObject([
      { kind: "message", text: expect.stringContaining("No collection.json") },
    ]);
    fs.rmSync(empty, { recursive: true, force: true });
  });
});
