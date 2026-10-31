import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { buildAuthorizationUrl, createPkce } from "@/core/http/oauth2-pkce";
import { applyAuth } from "@/core/http/auth";
import { authSchema } from "@/core/schemas";
import type { OAuth2Config, PreparedRequest } from "@/core/types";
import { DEFAULT_SETTINGS } from "@/core/types";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-authcode-"));
process.env.DATABASE_PATH = path.join(dir, "test.db");

let repo: typeof import("@/server/repo");
let authorizeRoute: typeof import("@/app/api/oauth2/authorize/route");
let callbackRoute: typeof import("@/app/api/oauth2/callback/route");
let pendingStore: typeof import("@/server/oauth2-pending");
let provider: http.Server;
let base = "";
const exchanges: URLSearchParams[] = [];
const challenges = new Map<string, string>();

beforeAll(async () => {
  repo = await import("@/server/repo");
  authorizeRoute = await import("@/app/api/oauth2/authorize/route");
  callbackRoute = await import("@/app/api/oauth2/callback/route");
  pendingStore = await import("@/server/oauth2-pending");
  provider = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const form = new URLSearchParams(body);
      exchanges.push(form);
      const challenge = challenges.get(form.get("code") ?? "");
      const verifier = form.get("code_verifier") ?? "";
      const ok =
        form.get("grant_type") === "authorization_code" &&
        challenge !== undefined &&
        (challenge === "" || createHash("sha256").update(verifier).digest("base64url") === challenge);
      res.setHeader("Content-Type", "application/json");
      if (!ok) return res.writeHead(400).end(JSON.stringify({ error: "invalid_grant" }));
      res.end(
        JSON.stringify({ access_token: `tok-${form.get("code")}`, token_type: "Bearer", expires_in: 3600 }),
      );
    });
  });
  await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
});
afterAll(async () => {
  provider.close();
  (await import("@/server/db")).getSqlite().close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const config = (): OAuth2Config => ({
  grantType: "authorization_code",
  authUrl: "https://idp.example/authorize?audience=api",
  accessTokenUrl: `${base}/token`,
  clientId: "cid",
  clientSecret: "",
  scope: "read write",
  clientAuthentication: "header",
  accessToken: "",
  headerPrefix: "Bearer",
});

async function start(workspaceId: string, cfg = config()) {
  const res = await authorizeRoute.POST(
    new Request("http://localhost/api/oauth2/authorize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId,
        callbackUrl: "http://localhost:3000/api/oauth2/callback",
        config: cfg,
      }),
    }),
  );
  expect(res.status).toBe(200);
  const data = (await res.json()) as { authorizationUrl: string; state: string; redirectUri: string };
  return { ...data, url: new URL(data.authorizationUrl) };
}
const callback = (query: string) =>
  callbackRoute.GET(new Request(`http://localhost/api/oauth2/callback?${query}`)).then(async (r) => ({
    status: r.status,
    html: await r.text(),
  }));
const result = (state: string) =>
  authorizeRoute
    .GET(new Request(`http://localhost/api/oauth2/authorize?state=${encodeURIComponent(state)}`))
    .then(async (r) => ({ status: r.status, body: await r.json() }));

describe("PKCE", () => {
  it("matches the RFC 7636 appendix B example", () => {
    const pkce = createPkce("S256", "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");
    expect(pkce.challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    expect(createPkce().verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("builds the authorization URL and keeps existing parameters", () => {
    const url = new URL(
      buildAuthorizationUrl(config(), {
        state: "s",
        redirectUri: "https://pb/cb",
        pkce: createPkce("S256", "v".repeat(43)),
      }),
    );
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      audience: "api",
      response_type: "code",
      client_id: "cid",
      redirect_uri: "https://pb/cb",
      scope: "read write",
      state: "s",
      code_challenge_method: "S256",
    });
    expect(() =>
      buildAuthorizationUrl(
        { ...config(), authUrl: "javascript:alert(1)" },
        { state: "s", redirectUri: "x" },
      ),
    ).toThrow();
  });
});

describe("authorization code login", () => {
  it("exchanges the code server-side with the PKCE verifier and hands out the token once", async () => {
    const ws = repo.createWorkspace("Auth code");
    const { url, state, redirectUri } = await start(ws.id);
    expect(url.origin).toBe("https://idp.example");
    expect(redirectUri).toBe("http://localhost:3000/api/oauth2/callback");
    expect(url.searchParams.get("state")).toBe(state);
    challenges.set("code-1", url.searchParams.get("code_challenge")!);
    expect((await result(state)).body).toEqual({ status: "pending" });

    const page = await callback(`code=code-1&state=${state}`);
    expect(page.html).toContain("Signed in");
    expect(page.html).toContain('"type":"postbox-oauth2"');
    expect(page.html).toContain("location.origin");
    const exchange = exchanges.at(-1)!;
    expect(exchange.get("redirect_uri")).toBe(redirectUri);
    expect(exchange.get("client_id")).toBe("cid");
    expect(exchange.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);

    expect((await result(state)).body).toMatchObject({
      status: "done",
      accessToken: "tok-code-1",
      tokenType: "Bearer",
    });
    expect((await result(state)).status).toBe(404);
    // A replayed callback cannot reuse the state.
    expect((await callback(`code=code-1&state=${state}`)).html).toContain("Authorization failed");
  });

  it("rejects unknown state and states owned by another session without exchanging", async () => {
    const before = exchanges.length;
    expect((await callback("code=x&state=forged")).html).toContain("unknown, expired");
    const ws = repo.createWorkspace("Foreign");
    const { state } = await start(ws.id);
    pendingStore.getPending(state)!.owner = "user:someone-else";
    expect((await callback(`code=x&state=${state}`)).html).toContain("another session");
    expect((await result(state)).status).toBe(404);
    expect(exchanges.length).toBe(before);
  });

  it("reports provider denial and failed exchanges", async () => {
    const ws = repo.createWorkspace("Denied");
    const denied = await start(ws.id);
    const page = await callback(
      `error=access_denied&error_description=${encodeURIComponent("<b>no</b>")}&state=${denied.state}`,
    );
    expect(page.html).toContain("Authorization denied: access_denied (&lt;b&gt;no&lt;/b&gt;)");
    expect((await result(denied.state)).body).toEqual({
      status: "error",
      error: "Authorization denied: access_denied (<b>no</b>)",
    });

    const bad = await start(ws.id);
    challenges.set("code-bad", "not-the-challenge");
    expect((await callback(`code=code-bad&state=${bad.state}`)).html).toContain("invalid_grant");
    expect((await result(bad.state)).body.status).toBe("error");
  });

  it("supports PKCE off and plain, and a configured redirect URI", async () => {
    const ws = repo.createWorkspace("Options");
    const off = await start(ws.id, { ...config(), usePkce: false, redirectUri: "https://registered/cb" });
    expect(off.url.searchParams.has("code_challenge")).toBe(false);
    expect(off.redirectUri).toBe("https://registered/cb");
    challenges.set("code-off", "");
    await callback(`code=code-off&state=${off.state}`);
    expect(exchanges.at(-1)!.has("code_verifier")).toBe(false);
    expect(exchanges.at(-1)!.get("redirect_uri")).toBe("https://registered/cb");
    const plain = await start(ws.id, { ...config(), codeChallengeMethod: "plain" });
    expect(plain.url.searchParams.get("code_challenge_method")).toBe("plain");
  });

  it("rejects callback URLs outside /api/oauth2/callback and foreign folders", async () => {
    const ws = repo.createWorkspace("Validation");
    const other = repo.createWorkspace("Other");
    const folder = repo.createFolder(other.id, null, { name: "x" });
    const call = (body: object) =>
      authorizeRoute.POST(
        new Request("http://localhost/api/oauth2/authorize", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspaceId: ws.id,
            callbackUrl: "http://localhost/api/oauth2/callback",
            config: config(),
            ...body,
          }),
        }),
      );
    expect((await call({ callbackUrl: "https://evil.example/steal" })).status).toBe(400);
    expect((await call({ folderId: folder.id })).status).toBe(404);
    expect((await call({ config: { ...config(), authUrl: "" } })).status).toBe(400);
  });
});

describe("sending with an authorization-code token", () => {
  const req = (): PreparedRequest => ({
    method: "GET",
    url: "https://api/",
    headers: [],
    settings: DEFAULT_SETTINGS,
  });

  it("uses the saved token and never fetches one silently", async () => {
    const r = req();
    await applyAuth(r, { type: "oauth2", oauth2: { ...config(), accessToken: "saved" } });
    expect(r.headers).toContainEqual(["Authorization", "Bearer saved"]);
    await expect(applyAuth(req(), { type: "oauth2", oauth2: config() })).rejects.toThrow(
      /Get New Access Token/,
    );
    expect(authSchema.parse({ type: "oauth2", oauth2: config() })).toMatchObject({
      oauth2: { grantType: "authorization_code", authUrl: "https://idp.example/authorize?audience=api" },
    });
  });
});
