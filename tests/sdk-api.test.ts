import { beforeAll, afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Caller } from "@/server/caller";
import type { UserRow } from "@/server/db/schema";
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-sdk-api-"));
process.env.DATABASE_PATH = path.join(directory, "test.db");
const repo = await import("@/server/repo"),
  catalog = await import("@/server/catalog"),
  users = await import("@/server/users");
const { getSqlite } = await import("@/server/db");
const { withCaller } = await import("@/server/access-context");
const { setMember } = await import("@/server/authorize");
const { generateCatalogSdk } = await import("@/server/sdk");
const as = (user: UserRow): Caller => ({ kind: "user", user, via: "token" });
let owner: UserRow, viewer: UserRow, outsider: UserRow;
const tokens: Record<string, string> = {};
beforeAll(async () => {
  owner = await users.createUser({ username: "sdk-owner", password: "password123" });
  viewer = await users.createUser({ username: "sdk-viewer", password: "password123" });
  outsider = await users.createUser({ username: "sdk-outsider", password: "password123" });
  for (const user of [owner, viewer, outsider]) tokens[user.id] = users.createToken(user.id, "test").token;
});
afterAll(() => {
  getSqlite().close();
  fs.rmSync(directory, { recursive: true, force: true });
});
const publication = (visibility: "private" | "team" | "public", expectedRevision = 0, label = "1.0.0") => ({
  visibility,
  expectedRevision,
  label,
  title: "SDK API",
  owners: ["API team"],
  tags: ["sdk"],
});
const setup = () =>
  withCaller(as(owner), () => {
    const ws = repo.createWorkspace("SDK source");
    setMember(ws.id, viewer.username, "viewer");
    const folder = repo.createFolder(ws.id, null, {
      auth: { type: "bearer", bearer: { token: "sdk-source-auth-secret" } },
    });
    const request = repo.createRequest(ws.id, folder.id, {
      name: "Get pet",
      url: "https://example.test/pets/{{id}}",
      testScript: "sdk-script-secret",
    });
    return { ws, folder, request };
  });
const req = (id: string, user?: UserRow, query = "") =>
  new Request(`http://localhost/api/catalog/${id}?format=sdk&language=typescript&name=api_client${query}`, {
    headers: user ? { authorization: `Bearer ${tokens[user.id]}` } : {},
  });
describe("catalog SDK artifacts", () => {
  it("enforces private/team/public access on artifact downloads and after revocation", async () => {
    const { folder } = setup();
    const entry = withCaller(as(owner), () => catalog.publishCatalog(folder.id, publication("private")));
    const { GET } = await import("@/app/api/catalog/[id]/route");
    const ctx = { params: Promise.resolve({ id: entry.id }) };
    expect((await GET(req(entry.id), ctx)).status).toBe(404);
    expect((await GET(req(entry.id, viewer), ctx)).status).toBe(404);
    expect((await GET(req(entry.id, owner), ctx)).status).toBe(200);
    withCaller(as(owner), () => catalog.updateCatalog(folder.id, publication("team", 1)));
    expect((await GET(req(entry.id, viewer), ctx)).status).toBe(200);
    expect((await GET(req(entry.id, outsider), ctx)).status).toBe(404);
    withCaller(as(owner), () => catalog.updateCatalog(folder.id, publication("public", 2)));
    const response = await GET(req(entry.id), ctx);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-disposition")).toContain("api_client-1.0.0.tgz");
    expect(response.headers.get("x-sdk-sha256")).toMatch(/^[a-f0-9]{64}$/);
    withCaller(as(owner), () => catalog.revokeCatalog(folder.id));
    expect((await GET(req(entry.id), ctx)).status).toBe(404);
  });
  it("regenerates pinned immutable versions, retains auth metadata and omits credentials/scripts", () => {
    const { folder, request } = setup();
    let id = "";
    withCaller(as(owner), () => {
      id = catalog.publishCatalog(folder.id, publication("public")).id;
      repo.updateRequest(request.id, { url: "https://example.test/v2/pets/{{id}}" });
      catalog.publishCatalog(folder.id, publication("public", 1, "2.0.0"));
    });
    const first = generateCatalogSdk(id, 1, "typescript", "api_client", null),
      second = generateCatalogSdk(id, 2, "typescript", "api_client", null);
    expect(first.filename).toBe("api_client-1.0.0.tgz");
    expect(second.filename).toBe("api_client-2.0.0.tgz");
    expect(first.sha256).not.toBe(second.sha256);
    expect(first.sha256).toBe(generateCatalogSdk(id, 1, "typescript", "api_client", null).sha256);
    const manifest = JSON.parse(first.files["sdk-manifest.json"]);
    expect(manifest.operations[0].authRequired).toBe(true);
    expect(JSON.stringify(first.files)).not.toContain("sdk-source-auth-secret");
    expect(JSON.stringify(first.files)).not.toContain("sdk-script-secret");
    expect(() => generateCatalogSdk(id, 999, "python", "api_client", null)).toThrow();
  });
});
