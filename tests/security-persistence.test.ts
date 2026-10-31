import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getOAuth2Token, clearOAuth2Cache } from "@/core/http/auth";
import { execute } from "@/core/executor";
import { CookieJarStore } from "@/core/http/cookies";
import { emptyScopes, redactStoredValue } from "@/core/variables/resolver";
import type { OAuth2Config, RequestDef } from "@/core/types";
import { DEFAULT_SETTINGS } from "@/core/types";
import { startTestServer, type TestServer } from "./helpers/server";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-security-"));
process.env.DATABASE_PATH = path.join(dir, "test.db");
let repo: typeof import("@/server/repo");
let context: typeof import("@/server/context");
let runs: typeof import("@/server/runs");
let folderRoute: typeof import("@/app/api/folders/[id]/route");
let db: typeof import("@/server/db");
let target: TestServer;
let tokens: http.Server;
let tokenUrl: string;
let fetched = 0;
let duringToken: (() => void) | undefined;

beforeAll(async () => {
  repo = await import("@/server/repo");
  context = await import("@/server/context");
  runs = await import("@/server/runs");
  folderRoute = await import("@/app/api/folders/[id]/route");
  db = await import("@/server/db");
  target = await startTestServer();
  tokens = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const url = new URL(req.url!, "http://localhost");
      if (url.pathname === "/echo") {
        const token = url.searchParams.get("token") ?? "";
        res.writeHead(200, { "Content-Type": "application/json", "X-Secret": token });
        res.end(JSON.stringify({ query: { token } }));
        return;
      }
      const ttl = url.searchParams.get("ttl");
      duringToken?.();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          access_token: `token-${++fetched}`,
          ...(ttl === "none" ? {} : { expires_in: Number(ttl ?? 3600) }),
        }),
      );
    });
  });
  await new Promise<void>((resolve) => tokens.listen(0, "127.0.0.1", resolve));
  tokenUrl = `http://127.0.0.1:${(tokens.address() as AddressInfo).port}/token`;
});
afterEach(() => {
  clearOAuth2Cache();
  duringToken = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
});
afterAll(async () => {
  await target.close();
  await new Promise<void>((resolve) => tokens.close(() => resolve()));
  db.getSqlite().close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function oauth(patch: Partial<OAuth2Config> = {}): OAuth2Config {
  return {
    grantType: "client_credentials",
    accessTokenUrl: tokenUrl,
    clientId: "client",
    clientSecret: "credential",
    scope: "",
    clientAuthentication: "header",
    accessToken: "",
    headerPrefix: "Bearer",
    ...patch,
  };
}
function fixture(auth: RequestDef["auth"] = { type: "none" }) {
  const ws = repo.createWorkspace("Security");
  const folder = repo.createFolder(ws.id, null);
  const request = repo.createRequest(ws.id, folder.id, { url: target.url + "/echo", auth });
  return { workspaceId: ws.id, environmentId: null, folderId: folder.id, requestId: request.id, request };
}

describe("OAuth credential isolation and persistence", () => {
  it("isolates credential, password, client-authentication and workspace changes", async () => {
    const config = oauth();
    const initial = await getOAuth2Token(config, { oauth2CacheScope: "workspace-one" });
    expect(await getOAuth2Token(config, { oauth2CacheScope: "workspace-one" })).toEqual(initial);
    for (const [changed, scope] of [
      [{ clientSecret: "rotated" }, "workspace-one"],
      [{ password: "rotated" }, "workspace-one"],
      [{ clientAuthentication: "body" }, "workspace-one"],
      [{}, "workspace-two"],
    ] as const) {
      expect(
        (
          await getOAuth2Token(
            {
              ...config,
              accessToken: initial!.accessToken,
              expiresAt: initial!.expiresAt,
              tokenContext: initial!.contextKey,
              ...changed,
            },
            { oauth2CacheScope: scope },
          )
        )?.accessToken,
      ).not.toBe(initial?.accessToken);
    }
  });

  it("bounds expiry for tokens without expires_in, expires cache entries and evicts oldest entries", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const config = oauth({ accessTokenUrl: tokenUrl + "?ttl=none" });
    const initial = (await getOAuth2Token(config))!;
    expect(initial.expiresAt).toBeGreaterThan(Date.now());
    expect(initial.expiresAt! - Date.now()).toBeLessThanOrEqual(5 * 60 * 1000);
    vi.setSystemTime(Date.now() + 6 * 60 * 1000);
    expect((await getOAuth2Token(config))?.accessToken).not.toBe(initial.accessToken);
    const expired = oauth({ accessTokenUrl: tokenUrl + "?ttl=0" });
    const expiredToken = await getOAuth2Token(expired);
    expect(expiredToken?.expiresAt).toBeLessThanOrEqual(Date.now());
    expect((await getOAuth2Token(expired))?.accessToken).not.toBe(expiredToken?.accessToken);
    clearOAuth2Cache();
    const first = await getOAuth2Token(oauth({ clientId: "entry-0" }));
    for (let i = 1; i <= 256; i++) await getOAuth2Token(oauth({ clientId: `entry-${i}` }));
    expect((await getOAuth2Token(oauth({ clientId: "entry-0" })))?.accessToken).not.toBe(first?.accessToken);
  });

  it("persists refreshed tokens to saved requests and reuses them after cache reset", async () => {
    const input = fixture({ type: "oauth2", oauth2: oauth() });
    const before = fetched;
    await context.runSingleRequest(input);
    const saved = repo.getRequest(input.requestId)!;
    expect(saved.auth).toMatchObject({
      type: "oauth2",
      oauth2: {
        accessToken: `token-${before + 1}`,
        tokenContext: expect.any(String),
        expiresAt: expect.any(Number),
      },
    });
    clearOAuth2Cache();
    await context.runSingleRequest({ ...input, request: saved });
    expect(fetched).toBe(before + 1);
    // Persisted tokens are also bound to resolved credentials, not just the auth owner.
    if (saved.auth.type !== "oauth2") throw new Error("OAuth expected");
    await context.runSingleRequest({
      ...input,
      request: {
        ...saved,
        auth: { type: "oauth2", oauth2: { ...saved.auth.oauth2, clientSecret: "changed" } },
      },
    });
    expect(fetched).toBe(before + 2);
  });

  it("persists to inherited folder auth during collection runs without overwriting request inheritance", async () => {
    const input = fixture({ type: "inherit" });
    repo.updateFolder(input.folderId, { auth: { type: "oauth2", oauth2: oauth() } });
    const before = fetched;
    await runs.startRun(input);
    expect(repo.getFolder(input.folderId)?.auth).toMatchObject({
      type: "oauth2",
      oauth2: { accessToken: `token-${before + 1}` },
    });
    expect(repo.getRequest(input.requestId)?.auth).toEqual({ type: "inherit" });
  });

  it("does not clobber auth edits made while refreshing a token", async () => {
    const input = fixture({ type: "oauth2", oauth2: oauth() });
    duringToken = () => repo.updateRequest(input.requestId, { auth: { type: "none" } });
    await context.runSingleRequest(input);
    expect(repo.getRequest(input.requestId)?.auth).toEqual({ type: "none" });
  });
});

describe("execution cookie opt-out", () => {
  it("never reads or writes the jar, including script requests and pm.cookies", async () => {
    const jar = new CookieJarStore();
    await jar.storeSetCookies(["existing=secret; Path=/"], target.url);
    const read = vi.spyOn(jar, "list");
    const header = vi.spyOn(jar, "getCookieHeader");
    const write = vi.spyOn(jar, "storeSetCookies");
    const input = fixture();
    const result = await execute({
      request: {
        ...input.request,
        url: target.url + "/set-cookie",
        settings: { ...DEFAULT_SETTINGS, useCookieJar: false },
        preRequestScript: `pm.test("no cookies", () => pm.expect(pm.cookies.get("existing")).to.equal(undefined)); const r = await pm.sendRequest("${target.url}/echo"); pm.test("no cookie header", () => pm.expect(r.json().headers.cookie).to.equal(undefined));`,
      },
      ancestors: [],
      scopes: emptyScopes(),
      cookieJar: jar,
    });
    expect(result.tests.every((test) => test.passed)).toBe(true);
    expect(result.scriptErrors).toEqual([]);
    expect(read).not.toHaveBeenCalled();
    expect(header).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    const loadCookies = vi.spyOn(repo, "listCookies");
    const saveCookies = vi.spyOn(repo, "saveCookies");
    await context.runSingleRequest({
      ...input,
      request: { ...input.request, settings: { ...DEFAULT_SETTINGS, useCookieJar: false } },
    });
    expect(loadCookies).not.toHaveBeenCalled();
    expect(saveCookies).not.toHaveBeenCalled();
  });
});

describe("stored secret redaction", () => {
  it("redacts short, URL-encoded and JSON-escaped values without mutating the input", () => {
    const value = {
      raw: 'pass"word',
      encoded: encodeURIComponent('pass"word'),
      escaped: JSON.stringify('pass"word'),
      short: "xy",
    };
    const safe = redactStoredValue(value, ['pass"word', "xy"]);
    expect(JSON.stringify(safe)).not.toContain("pass");
    expect(safe.short).toBe("********");
    expect(value.raw).toBe('pass"word');
    for (const secret of [".*[x](a)+?^$|{}\\", "*", "\ud800"]) {
      expect(redactStoredValue({ text: secret }, [secret])).toEqual({ text: "********" });
    }
  });

  it("redacts history request snapshots, response bodies/headers and script-updated secrets", async () => {
    const input = fixture();
    const secret = "history-secret-value";
    repo.replaceVariables(input.workspaceId, "global", null, [
      { key: "token", value: secret, type: "secret", enabled: true },
    ]);
    const result = await context.runSingleRequest({
      ...input,
      request: {
        ...input.request,
        url: `${tokenUrl.replace("/token", "/echo")}?token={{token}}`,
        headers: [{ key: "X-Token", value: secret, enabled: true }],
        preRequestScript: `pm.globals.set("token", "rotated-secret-value");`,
      },
    });
    const stored = repo.getHistory(result.historyId!)!;
    expect(JSON.stringify(stored)).not.toContain(secret);
    expect(JSON.stringify(stored)).not.toContain("rotated-secret-value");
    // The live response stays available to scripts and the requesting client.
    expect(result.response?.bodyText).toContain("rotated-secret-value");
    const run = await runs.startRun({ ...input, options: { persistVariables: false } });
    expect(JSON.stringify(runs.getRunSummary(run.runId))).not.toContain("rotated-secret-value");
  });

  it("redacts direct, inherited and freshly issued auth credentials from request history", async () => {
    const directSecret = "direct-history-auth-secret";
    const direct = fixture({ type: "bearer", bearer: { token: directSecret } });
    direct.request.url += "?api_key=query-history-auth-secret";
    direct.request.headers = [{ key: "X-API-Key", value: "header-history-auth-secret", enabled: true }];
    const directResult = await context.runSingleRequest(direct);
    const directHistory = JSON.stringify(repo.getHistory(directResult.historyId!));
    for (const secret of [directSecret, "query-history-auth-secret", "header-history-auth-secret"]) {
      expect(directHistory).not.toContain(secret);
    }

    const inheritedSecret = "inherited-history-auth-secret";
    const inherited = fixture({ type: "inherit" });
    repo.updateFolder(inherited.folderId, {
      auth: { type: "basic", basic: { username: "history-user", password: inheritedSecret } },
    });
    const inheritedResult = await context.runSingleRequest(inherited);
    expect(JSON.stringify(repo.getHistory(inheritedResult.historyId!))).not.toContain(inheritedSecret);

    const config = oauth({ accessTokenUrl: tokenUrl + "?ttl=3600", clientSecret: "oauth-client-secret" });
    // The token endpoint fixture generates its own token; ensure the persisted history also
    // redacts the token returned by the OAuth helper, regardless of its transport location.
    const oauthInput = fixture({ type: "oauth2", oauth2: config });
    const oauthResult = await context.runSingleRequest(oauthInput);
    const issuedToken = oauthResult.oauth2Token?.accessToken;
    expect(issuedToken).toBeTruthy();
    const oauthHistory = JSON.stringify(repo.getHistory(oauthResult.historyId!));
    expect(oauthHistory).not.toContain(issuedToken);
    expect(oauthHistory).not.toContain("oauth-client-secret");
  });

  it("preserves stable IDs when a short secret overlaps references", async () => {
    const input = fixture();
    const secret = input.workspaceId.slice(0, 2);
    repo.replaceVariables(input.workspaceId, "global", null, [
      { key: "token", value: secret, type: "secret", enabled: true },
    ]);
    const result = await context.runSingleRequest(input);
    const stored = repo.getHistory(result.historyId!)!;
    expect(stored.workspaceId).toBe(input.workspaceId);
    expect(stored.requestId).toBe(input.requestId);
    expect(stored.request).toMatchObject({ id: input.requestId, folderId: input.folderId });
    const run = await runs.startRun(input);
    expect(runs.getRunSummary(run.runId)?.results[0].requestId).toBe(input.requestId);
  });

  it("redacts collection result assertions, headers and echoed bodies using updated secret values", async () => {
    const input = fixture();
    repo.replaceVariables(input.workspaceId, "global", null, [
      { key: "token", value: "before-secret", type: "secret", enabled: true },
    ]);
    repo.updateRequest(input.requestId, {
      url: `${target.url}/echo?token={{token}}`,
      preRequestScript: 'pm.globals.set("token", "after-secret");',
      testScript: 'pm.test("echo", () => { throw new Error(pm.response.json().query.token); });',
    });
    const { runId, summary } = await runs.startRun({ ...input, options: { persistVariables: false } });
    expect(summary.status).toBe("failed");
    const stored = JSON.stringify(runs.getRunSummary(runId));
    expect(stored).not.toContain("before-secret");
    expect(stored).not.toContain("after-secret");
    expect(summary.results[0].tests[0].error).toContain("********");
  });
});

describe("folder PATCH moves", () => {
  it("rejects cycles and cross-workspace parents, and moves valid folders", async () => {
    const input = fixture();
    const child = repo.createFolder(input.workspaceId, input.folderId);
    const grandchild = repo.createFolder(input.workspaceId, child.id);
    const other = fixture();
    const patch = (id: string, parentId: string | null) =>
      folderRoute.PATCH(
        new Request(`http://localhost/api/folders/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ parentId }),
        }),
        { params: Promise.resolve({ id }) },
      );
    expect((await patch(input.folderId, input.folderId)).status).toBe(400);
    expect((await patch(input.folderId, grandchild.id)).status).toBe(400);
    expect((await patch(child.id, other.folderId)).status).toBe(400);
    expect(repo.getFolder(input.folderId)?.parentId).toBeNull();
    expect((await patch(grandchild.id, input.folderId)).status).toBe(200);
    expect(repo.getFolder(grandchild.id)?.parentId).toBe(input.folderId);
  });
});
