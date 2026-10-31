import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { applyAuth, type OAuth2Token } from "@/core/http/auth";
import { authCredentialValues, restoreMissingCredentials, withoutAuthCredentials } from "@/core/retention";
import { authSchema } from "@/core/schemas";
import type { AuthConfig, OAuth2Config, PreparedRequest } from "@/core/types";
import { DEFAULT_SETTINGS } from "@/core/types";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-refresh-"));
process.env.DATABASE_PATH = path.join(dir, "test.db");

const calls: URLSearchParams[] = [];
let base = "";
const provider = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const form = new URLSearchParams(body);
    calls.push(form);
    res.setHeader("Content-Type", "application/json");
    setTimeout(() => {
      const rt = form.get("refresh_token");
      if (form.get("grant_type") !== "refresh_token" || !rt?.startsWith("r"))
        return res.writeHead(400).end(JSON.stringify({ error: "invalid_grant" }));
      const n = Number(rt.slice(1)) + 1;
      // r9 is a provider that does not rotate refresh tokens.
      res.end(
        JSON.stringify({
          access_token: `a${n}`,
          token_type: "Bearer",
          expires_in: 600,
          ...(rt === "r9" ? {} : { refresh_token: `r${n}` }),
        }),
      );
    }, 50);
  });
});
beforeAll(async () => {
  await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
});
afterAll(async () => {
  provider.close();
  (await import("@/server/db")).getSqlite().close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const config = (patch: Partial<OAuth2Config> = {}): OAuth2Config => ({
  grantType: "authorization_code",
  authUrl: "https://idp/authorize",
  accessTokenUrl: `${base}/token`,
  clientId: "cid",
  clientSecret: "",
  scope: "",
  clientAuthentication: "header",
  accessToken: "a1",
  refreshToken: "r1",
  expiresAt: Date.now() - 1000,
  headerPrefix: "Bearer",
  ...patch,
});
const req = (): PreparedRequest => ({
  method: "GET",
  url: "https://api/",
  headers: [],
  settings: DEFAULT_SETTINGS,
});
const send = async (o: OAuth2Config) => {
  const r = req();
  const { oauth2Token } = await applyAuth(r, { type: "oauth2", oauth2: o });
  return { header: r.headers.find(([k]) => k === "Authorization")?.[1], token: oauth2Token as OAuth2Token };
};

describe("OAuth 2.0 refresh tokens", () => {
  it("refreshes an expired token and keeps the rotated refresh token", async () => {
    calls.length = 0;
    const { header, token } = await send(config());
    expect(header).toBe("Bearer a2");
    expect(token).toMatchObject({ accessToken: "a2", refreshToken: "r2" });
    expect(token.expiresAt).toBeGreaterThan(Date.now());
    expect(Object.fromEntries(calls[0])).toEqual({
      grant_type: "refresh_token",
      refresh_token: "r1",
      client_id: "cid",
    });
  });

  it("keeps the old refresh token when the provider does not rotate it", async () => {
    expect((await send(config({ refreshToken: "r9" }))).token.refreshToken).toBe("r9");
  });

  it("shares one refresh between concurrent sends", async () => {
    calls.length = 0;
    const results = await Promise.all(Array.from({ length: 5 }, () => send(config({ refreshToken: "r5" }))));
    expect(calls).toHaveLength(1);
    expect(new Set(results.map((r) => r.header))).toEqual(new Set(["Bearer a6"]));
  });

  it("uses a fresh token without calling the provider", async () => {
    calls.length = 0;
    expect((await send(config({ expiresAt: Date.now() + 600_000 }))).header).toBe("Bearer a1");
    expect((await send(config({ refreshToken: undefined }))).header).toBe("Bearer a1");
    expect(calls).toHaveLength(0);
  });

  it("refuses tokens issued for different client settings and reports failed refreshes", async () => {
    await expect(send(config({ tokenContext: "issued-for-other-settings" }))).rejects.toThrow(
      /settings changed/,
    );
    await expect(send(config({ refreshToken: "x-revoked" }))).rejects.toThrow(
      /token refresh failed \(400\).*Sign in again/,
    );
  });
});

describe("refresh token storage", () => {
  it("persists refreshed tokens on the owning request", async () => {
    const repo = await import("@/server/repo");
    const { persistOAuth2Token } = await import("@/server/context");
    const ws = repo.createWorkspace("Refresh");
    const folder = repo.createFolder(ws.id, null, { name: "c" });
    const auth: AuthConfig = { type: "oauth2", oauth2: config() };
    const request = repo.createRequest(ws.id, folder.id, { url: "https://api/", auth });
    const { token } = await send(config());
    persistOAuth2Token(ws.id, request, [], token, request.id);
    expect(repo.getRequest(request.id)!.auth).toMatchObject({
      type: "oauth2",
      oauth2: { accessToken: "a2", refreshToken: "r2" },
    });
  });

  it("treats the refresh token as a credential", () => {
    const auth: AuthConfig = { type: "oauth2", oauth2: config({ refreshToken: "RTSECRET" }) };
    expect(authCredentialValues(auth)).toContain("RTSECRET");
    const stripped = withoutAuthCredentials(auth);
    expect(JSON.stringify(stripped)).not.toContain("RTSECRET");
    expect(restoreMissingCredentials(stripped, auth)).toMatchObject({ oauth2: { refreshToken: "RTSECRET" } });
    expect(authSchema.parse(auth)).toMatchObject({ oauth2: { refreshToken: "RTSECRET" } });
  });
});
