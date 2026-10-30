/**
 * Workspace ownership and input validation at the API boundary (LAB-43):
 * IDs from another workspace are rejected like missing ones, request bodies
 * are structurally validated and size-bounded, and sandbox messages are untrusted.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runScript, type ScriptContext } from "@/core/scripts/sandbox";
import { emptyScopes } from "@/core/variables/resolver";
import { startTestServer, type TestServer } from "./helpers/server";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-ownership-"));
process.env.DATABASE_PATH = path.join(dir, "test.db");

let repo: typeof import("@/server/repo");
let context: typeof import("@/server/context");
let runs: typeof import("@/server/runs");
let target: TestServer;

const routes = {
  proxy: () => import("@/app/api/proxy/route"),
  runs: () => import("@/app/api/runs/route"),
  codegen: () => import("@/app/api/codegen/route"),
  oauth2: () => import("@/app/api/oauth2/token/route"),
  folders: () => import("@/app/api/folders/route"),
  folder: () => import("@/app/api/folders/[id]/route"),
  requests: () => import("@/app/api/requests/route"),
  request: () => import("@/app/api/requests/[id]/route"),
  move: () => import("@/app/api/tree/move/route"),
  variables: () => import("@/app/api/variables/route"),
  environments: () => import("@/app/api/environments/route"),
  cookies: () => import("@/app/api/cookies/route"),
  mcp: () => import("@/app/api/mcp/route"),
};

const post = (url: string, body: unknown, method = "POST") =>
  new Request(`http://localhost${url}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const status = async (res: Promise<Response> | Response) => (await res).status;

let A: { ws: string; col: string; env: string; req: string };
let B: { ws: string; col: string; sub: string; env: string; req: string };

beforeAll(async () => {
  repo = await import("@/server/repo");
  context = await import("@/server/context");
  runs = await import("@/server/runs");
  target = await startTestServer();

  const wsA = repo.createWorkspace("A");
  const colA = repo.createFolder(wsA.id, null, { name: "A collection" });
  A = {
    ws: wsA.id,
    col: colA.id,
    env: repo.createEnvironment(wsA.id, "A env").id,
    req: repo.createRequest(wsA.id, colA.id, { url: `${target.url}/echo` }).id,
  };
  const wsB = repo.createWorkspace("B");
  const colB = repo.createFolder(wsB.id, null, {
    name: "B collection",
    auth: { type: "bearer", bearer: { token: "b-secret" } },
  });
  B = {
    ws: wsB.id,
    col: colB.id,
    sub: repo.createFolder(wsB.id, colB.id, { name: "B sub" }).id,
    env: repo.createEnvironment(wsB.id, "B env").id,
    req: repo.createRequest(wsB.id, colB.id, { url: `${target.url}/echo` }).id,
  };
});
afterAll(async () => {
  await target?.close();
});
afterEach(() => {
  delete process.env.API_BODY_LIMIT_MB;
});

describe("cross-workspace references", () => {
  it("never executes with another workspace's folder, request or environment", async () => {
    const { POST } = await routes.proxy();
    const request = { method: "GET", url: `${target.url}/echo` };
    const before = target.requests.length;
    for (const refs of [{ folderId: B.col }, { requestId: B.req }, { environmentId: B.env }]) {
      const res = await POST(post("/api/proxy", { workspaceId: A.ws, request, ...refs }));
      expect(res.status).toBe(404);
    }
    expect(target.requests.length).toBe(before);
    // The direct context call used by MCP send_request enforces the same rules.
    await expect(
      context.runSingleRequest({
        workspaceId: A.ws,
        environmentId: null,
        folderId: null,
        requestId: B.req,
        request: { ...repo.getRequest(B.req)!, settings: repo.getRequest(B.req)!.settings },
      }),
    ).rejects.toThrow(/Request not found/);
    expect(target.requests.length).toBe(before);
  });

  it("rejects foreign runs before streaming", async () => {
    const { POST } = await routes.runs();
    expect(await status(POST(post("/api/runs", { workspaceId: A.ws, folderId: B.col })))).toBe(404);
    expect(
      await status(POST(post("/api/runs", { workspaceId: A.ws, folderId: A.col, environmentId: B.env }))),
    ).toBe(404);
    await expect(runs.startRun({ workspaceId: A.ws, folderId: B.col, environmentId: null })).rejects.toThrow(
      /Folder not found/,
    );
  });

  it("does not apply a foreign folder's auth to code snippets or OAuth2 requests", async () => {
    const codegen = await routes.codegen();
    const res = await codegen.POST(
      post("/api/codegen", {
        workspaceId: A.ws,
        folderId: B.col,
        request: { url: "https://example.com" },
        language: "curl",
        resolveVariables: false,
      }),
    );
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("b-secret");
    const oauth2 = await routes.oauth2();
    expect(
      await status(
        oauth2.POST(
          post("/api/oauth2/token", {
            workspaceId: A.ws,
            folderId: B.col,
            config: { grantType: "client_credentials", accessTokenUrl: `${target.url}/echo` },
          }),
        ),
      ),
    ).toBe(404);
  });

  it("rejects creating or moving items under another workspace's folder", async () => {
    const folders = await routes.folders();
    expect(await status(folders.POST(post("/api/folders", { workspaceId: A.ws, parentId: B.col })))).toBe(
      404,
    );
    expect(await status(folders.POST(post("/api/folders", { workspaceId: "missing" })))).toBe(404);
    const requests = await routes.requests();
    expect(await status(requests.POST(post("/api/requests", { workspaceId: A.ws, folderId: B.col })))).toBe(
      404,
    );
    const move = await routes.move();
    expect(
      await status(
        move.POST(post("/api/tree/move", { kind: "request", id: A.req, parentId: B.col, index: 0 })),
      ),
    ).toBe(404);
    expect(
      await status(
        move.POST(post("/api/tree/move", { kind: "folder", id: B.col, parentId: B.sub, index: 0 })),
      ),
    ).toBe(400);
    expect(repo.getRequest(A.req)?.folderId).toBe(A.col);
    const folder = await routes.folder();
    expect(
      await status(folder.PATCH(post(`/api/folders/${A.col}`, { parentId: B.col }, "PATCH"), ctx(A.col))),
    ).toBe(400);
  });

  it("only writes variables to owners in the same workspace", async () => {
    const { PUT } = await routes.variables();
    const put = (body: Record<string, unknown>) =>
      status(PUT(post("/api/variables", { workspaceId: A.ws, variables: [{ key: "k" }], ...body }, "PUT")));
    expect(await put({ scope: "environment", ownerId: B.env })).toBe(404);
    expect(await put({ scope: "collection", ownerId: B.col })).toBe(404);
    expect(await put({ scope: "collection", ownerId: B.sub, workspaceId: B.ws })).toBe(400);
    expect(await put({ scope: "global", ownerId: A.env })).toBe(400);
    expect(await put({ scope: "environment", ownerId: null })).toBe(400);
    expect(await put({ scope: "environment", ownerId: A.env })).toBe(200);
    expect(repo.listVariables(A.ws, "environment", B.env)).toEqual([]);
    expect(() => repo.replaceVariables(A.ws, "environment", B.env, [])).toThrow(/Environment not found/);
  });

  it("requires an existing workspace for cookies and environments", async () => {
    const cookies = await routes.cookies();
    expect(
      await status(
        cookies.POST(
          post("/api/cookies", { workspaceId: "missing", cookie: { name: "a", value: "b", domain: "x" } }),
        ),
      ),
    ).toBe(404);
    const envs = await routes.environments();
    expect(await status(envs.POST(post("/api/environments", { workspaceId: "missing", name: "E" })))).toBe(
      404,
    );
  });
});

describe("request body validation", () => {
  it("rejects structurally invalid request, auth, header and variable payloads", async () => {
    const request = await routes.request();
    const patch = (body: unknown) =>
      status(request.PATCH(post(`/api/requests/${A.req}`, body, "PATCH"), ctx(A.req)));
    expect(await patch({ auth: { type: "bogus" } })).toBe(400);
    expect(await patch({ auth: { type: "bearer" } })).toBe(400);
    expect(await patch({ headers: "X-A: 1" })).toBe(400);
    expect(await patch({ method: "GE T" })).toBe(400);
    expect(await patch({ body: { mode: "raw", raw: 1 } })).toBe(400);
    expect(await patch({ settings: { timeoutMs: 5 } })).toBe(400);
    expect(await patch({ examples: [{ name: "no id" }] })).toBe(400);

    expect(await patch({ method: "PROPFIND", settings: { timeoutMs: 1234 }, ignored: true })).toBe(200);
    const saved = repo.getRequest(A.req)!;
    expect(saved.method).toBe("PROPFIND");
    expect(saved.settings).toMatchObject({ timeoutMs: 1234, followRedirects: true });

    const folder = await routes.folder();
    const folderPatch = (body: unknown) =>
      status(folder.PATCH(post(`/api/folders/${A.col}`, body, "PATCH"), ctx(A.col)));
    expect(await folderPatch({ auth: { type: "basic", basic: { username: 1 } } })).toBe(400);
    expect(await folderPatch({ headers: [{ value: "no key" }] })).toBe(400);
    expect(await folderPatch({ variables: [{ key: "k", value: 5 }] })).toBe(400);

    const proxy = await routes.proxy();
    expect(
      await status(
        proxy.POST(
          post("/api/proxy", { workspaceId: A.ws, request: { url: target.url, params: [{ key: 1 }] } }),
        ),
      ),
    ).toBe(400);
  });

  it("returns 413 for bodies over API_BODY_LIMIT_MB on REST and MCP", async () => {
    process.env.API_BODY_LIMIT_MB = "1";
    const big = JSON.stringify({ workspaceId: A.ws, request: { url: "x".repeat(1.2 * 1024 * 1024) } });
    const proxy = await routes.proxy();
    expect(await status(proxy.POST(post("/api/proxy", big)))).toBe(413);

    // Without a Content-Length header the stream is cut off while reading.
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(big));
        c.close();
      },
    });
    const chunked = new Request("http://localhost/api/proxy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: stream,
      // @ts-expect-error Node fetch requires duplex: "half" for stream bodies
      duplex: "half",
    });
    expect(await status(proxy.POST(chunked))).toBe(413);

    const mcp = await routes.mcp();
    const res = await mcp.POST(
      new Request("http://localhost/api/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: big,
      }),
    );
    expect(res.status).toBe(413);
  });
});

describe("sandbox host messages", () => {
  const scriptCtx = (): ScriptContext => ({
    scopes: emptyScopes(),
    request: { url: "https://example.com", method: "GET", headers: [] },
    info: { eventName: "prerequest", iteration: 0, iterationCount: 1, requestName: "r", requestId: "r" },
  });

  it("rejects malformed pm.sendRequest specs before any host work", async () => {
    const sendRequest = vi.fn();
    const result = await runScript(
      `try { await pm.sendRequest({ url: "https://example.com", method: "GE T" }); }
       catch (e) { console.log("caught " + e.message); }
       try { await __host_send("not json"); } catch (e) { console.log("caught " + e.message); }`,
      scriptCtx(),
      { host: { sendRequest } },
    );
    expect(sendRequest).not.toHaveBeenCalled();
    expect(result.logs.map((l) => l.message)).toEqual([
      expect.stringMatching(/caught Invalid pm.sendRequest request: method/),
      "caught pm.sendRequest received a request that is not JSON",
    ]);
  });

  it("does not trust a replaced __finalize or unknown console levels", async () => {
    const forged = await runScript(
      `globalThis.__finalize = function () {
         return JSON.stringify({ scopes: { globals: { a: { nested: true } } }, tests: "all passed" });
       };`,
      scriptCtx(),
    );
    expect(forged.error).toMatch(/Script produced an invalid result/);
    expect(forged.tests).toEqual([]);
    expect(forged.scopes).toEqual(scriptCtx().scopes);

    const logged = await runScript(`__host_log("<script>", "hi");`, scriptCtx());
    expect(logged.logs[0]).toMatchObject({ level: "log", message: "hi" });
  });
});
