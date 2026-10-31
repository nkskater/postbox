import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { AuthConfig, OAuth2Config } from "@/core/types";
import type { UserRow } from "@/server/db/schema";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-oauth-tokens-"));
process.env.DATABASE_PATH = path.join(dir, "test.db");
const { getSqlite } = await import("@/server/db");
const users = await import("@/server/users");
const repo = await import("@/server/repo");
const { withCaller } = await import("@/server/access-context");
const { setMember } = await import("@/server/authorize");
const listRoute = await import("@/app/api/oauth2/tokens/route");
const clearRoute = await import("@/app/api/oauth2/tokens/clear/route");
const clearAllRoute = await import("@/app/api/oauth2/tokens/clear-all/route");

const revocations: URLSearchParams[] = [];
let revokeStatus = 200;
const provider = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    revocations.push(new URLSearchParams(body));
    res.writeHead(revokeStatus).end();
  });
});
let base = "";
let owner: UserRow, editor: UserRow, viewer: UserRow;
const tokens: Record<string, string> = {};
let workspaceId = "";
let folderId = "";
let requestId = "";

const oauth = (patch: Partial<OAuth2Config> = {}): AuthConfig => ({
  type: "oauth2",
  oauth2: {
    grantType: "authorization_code",
    authUrl: "https://idp/authorize",
    accessTokenUrl: "https://idp.example/token",
    revocationUrl: `${base}/{{revokePath}}`,
    clientId: "cid",
    clientSecret: "csecret",
    scope: "",
    clientAuthentication: "header",
    accessToken: "AT-SECRET",
    refreshToken: "RT-SECRET",
    expiresAt: Date.now() + 60_000,
    headerPrefix: "Bearer",
    ...patch,
  },
});

beforeAll(async () => {
  await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
  await users.createUser({ username: "admin", password: "password123", isAdmin: true });
  owner = await users.createUser({ username: "owner", password: "password123" });
  editor = await users.createUser({ username: "editor", password: "password123" });
  viewer = await users.createUser({ username: "viewer", password: "password123" });
  for (const u of [owner, editor, viewer]) tokens[u.username] = users.createToken(u.id, "t").token;
  workspaceId = withCaller({ kind: "user", user: owner, via: "token" }, () =>
    repo.createWorkspace("Tokens"),
  ).id;
  withCaller({ kind: "user", user: owner, via: "token" }, () => {
    setMember(workspaceId, "editor", "editor");
    setMember(workspaceId, "viewer", "viewer");
  });
});
afterAll(() => {
  provider.close();
  getSqlite().close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function seed() {
  const folder = repo.createFolder(workspaceId, null, { name: "Collection", auth: oauth() });
  repo.replaceVariables(workspaceId, "collection", folder.id, [
    { key: "revokePath", value: "revoke", type: "default", enabled: true },
  ]);
  const request = repo.createRequest(workspaceId, folder.id, {
    name: "Me",
    url: "https://api/me",
    auth: oauth({ revocationUrl: undefined, refreshToken: undefined, accessToken: "AT2" }),
  });
  repo.createRequest(workspaceId, folder.id, {
    name: "No token",
    auth: oauth({ accessToken: "", refreshToken: undefined }),
  });
  folderId = folder.id;
  requestId = request.id;
}

const as = (user: string, method: string, url: string, body?: object) =>
  new Request(`http://localhost${url}`, {
    method,
    headers: { authorization: `Bearer ${tokens[user]}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

describe("saved OAuth token manager", () => {
  it("lists token metadata without values, for viewers too", async () => {
    seed();
    const res = await listRoute.GET(as("viewer", "GET", `/api/oauth2/tokens?workspaceId=${workspaceId}`));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toMatch(/AT-SECRET|RT-SECRET|AT2|csecret/);
    const list = JSON.parse(text);
    expect(list).toHaveLength(2);
    expect(list).toContainEqual(
      expect.objectContaining({
        kind: "folder",
        id: folderId,
        hasRefreshToken: true,
        canRevoke: true,
        tokenHost: "idp.example",
      }),
    );
    expect(list).toContainEqual(
      expect.objectContaining({ kind: "request", id: requestId, hasRefreshToken: false, canRevoke: false }),
    );
  });

  it("lets editors clear and revoke, but not viewers", async () => {
    const body = { workspaceId, kind: "folder", id: folderId, revoke: true };
    expect((await clearRoute.POST(as("viewer", "POST", "/api/oauth2/tokens/clear", body))).status).toBe(403);
    revocations.length = 0;
    const res = await clearRoute.POST(as("editor", "POST", "/api/oauth2/tokens/clear", body));
    expect(await res.json()).toEqual({ cleared: 1, revoked: 2, errors: [] });
    // Refresh token first, with client authentication; the URL variable was resolved.
    expect(revocations.map((r) => [r.get("token"), r.get("token_type_hint")])).toEqual([
      ["RT-SECRET", "refresh_token"],
      ["AT-SECRET", "access_token"],
    ]);
    expect(repo.getFolder(folderId)!.auth).toMatchObject({
      oauth2: { accessToken: "", clientSecret: "csecret" },
    });
    expect(
      (repo.getFolder(folderId)!.auth as Extract<AuthConfig, { type: "oauth2" }>).oauth2.refreshToken,
    ).toBeUndefined();
  });

  it("still clears locally when the provider refuses revocation", async () => {
    repo.updateFolder(folderId, { auth: oauth() });
    revokeStatus = 503;
    const res = await clearRoute.POST(
      as("editor", "POST", "/api/oauth2/tokens/clear", {
        workspaceId,
        kind: "folder",
        id: folderId,
        revoke: true,
      }),
    );
    revokeStatus = 200;
    const result = await res.json();
    expect(result).toMatchObject({ cleared: 1, revoked: 0 });
    expect(result.errors[0]).toMatch(/revocation failed \(503\)/);
    expect(repo.getFolder(folderId)!.auth).toMatchObject({ oauth2: { accessToken: "" } });
  });

  it("rejects targets from another workspace", async () => {
    const other = withCaller({ kind: "user", user: owner, via: "token" }, () =>
      repo.createWorkspace("Other"),
    );
    const foreign = repo.createFolder(other.id, null, { auth: oauth() });
    const res = await clearRoute.POST(
      as("editor", "POST", "/api/oauth2/tokens/clear", { workspaceId, kind: "folder", id: foreign.id }),
    );
    expect(res.status).toBe(404);
    expect(repo.getFolder(foreign.id)!.auth).toMatchObject({ oauth2: { accessToken: "AT-SECRET" } });
  });

  it("restricts clearing everything to workspace owners", async () => {
    repo.updateFolder(folderId, { auth: oauth() });
    expect(
      (await clearAllRoute.POST(as("editor", "POST", "/api/oauth2/tokens/clear-all", { workspaceId })))
        .status,
    ).toBe(403);
    const res = await clearAllRoute.POST(
      as("owner", "POST", "/api/oauth2/tokens/clear-all", { workspaceId }),
    );
    expect((await res.json()).cleared).toBe(2);
    const list = await listRoute.GET(as("owner", "GET", `/api/oauth2/tokens?workspaceId=${workspaceId}`));
    expect(await list.json()).toEqual([]);
  });
});
