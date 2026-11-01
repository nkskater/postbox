import { beforeAll, afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { Caller } from "@/server/caller";
import type { UserRow } from "@/server/db/schema";
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-documentation-"));
process.env.DATABASE_PATH = path.join(directory, "test.db");
const repo = await import("@/server/repo");
const docs = await import("@/server/documentation");
const users = await import("@/server/users");
const { getDb, getSqlite, schema } = await import("@/server/db");
const { withCaller } = await import("@/server/access-context");
const { setMember } = await import("@/server/authorize");
const as = (user: UserRow): Caller => ({ kind: "user", user, via: "token" });
let owner: UserRow, viewer: UserRow, editor: UserRow, outsider: UserRow;
const tokens: Record<string, string> = {};
beforeAll(async () => {
  owner = await users.createUser({ username: "docs-owner", password: "password123" });
  viewer = await users.createUser({ username: "docs-viewer", password: "password123" });
  editor = await users.createUser({ username: "docs-editor", password: "password123" });
  outsider = await users.createUser({ username: "docs-outsider", password: "password123" });
  for (const user of [owner, viewer, editor, outsider])
    tokens[user.id] = users.createToken(user.id, "test").token;
});
afterAll(() => {
  getSqlite().close();
  fs.rmSync(directory, { recursive: true, force: true });
});
const setup = () =>
  withCaller(as(owner), () => {
    const ws = repo.createWorkspace("Docs");
    setMember(ws.id, viewer.username, "viewer");
    setMember(ws.id, editor.username, "editor");
    const folder = repo.createFolder(ws.id, null, {
      name: "Pet docs",
      auth: { type: "bearer", bearer: { token: "docs-private-token" } },
    });
    const request = repo.createRequest(ws.id, folder.id, {
      name: "Get pet",
      url: "https://example.test/pets",
      description: "Original description",
      preRequestScript: 'throw new Error("do not execute")',
    });
    repo.replaceVariables(ws.id, "collection", folder.id, [
      { key: "apiKey", value: "docs-private-variable", type: "secret", enabled: true },
    ]);
    return { ws, folder, request };
  });
const req = (user: UserRow | undefined, url: string, method = "GET", body?: unknown) =>
  new Request(`http://localhost${url}`, {
    method,
    headers: {
      ...(user ? { authorization: `Bearer ${tokens[user.id]}` } : {}),
      "content-type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
describe("documentation publications", () => {
  it("keeps immutable snapshots until explicit optimistic republishing and revokes old URLs", () => {
    const { folder, request } = setup();
    withCaller(as(owner), () => {
      const first = docs.publishDocumentation(folder.id, { visibility: "public", expectedRevision: 0 });
      repo.updateRequest(request.id, { description: "Changed later" });
      expect(JSON.stringify(docs.visibleDocumentation(first.id, null).snapshot)).toContain(
        "Original description",
      );
      expect(() =>
        docs.publishDocumentation(folder.id, { visibility: "public", expectedRevision: 0 }),
      ).toThrow(/changed/);
      const next = docs.publishDocumentation(folder.id, { visibility: "private", expectedRevision: 1 });
      expect(next.id).toBe(first.id);
      expect(next.revision).toBe(2);
      expect(JSON.stringify(docs.visibleDocumentation(next.id, as(owner)).snapshot)).toContain(
        "Changed later",
      );
      expect(() => docs.visibleDocumentation(next.id, null)).toThrow();
      docs.revokeDocumentation(folder.id);
      expect(() => docs.visibleDocumentation(next.id, as(owner))).toThrow();
      const fresh = docs.publishDocumentation(folder.id, { visibility: "public", expectedRevision: 0 });
      expect(fresh.id).not.toBe(first.id);
    });
  });
  it("requires ownership for publishing, membership for private reads, and permits anonymous public reads", () => {
    const { folder } = setup();
    const publication = withCaller(as(owner), () =>
      docs.publishDocumentation(folder.id, { visibility: "private", expectedRevision: 0 }),
    );
    for (const user of [viewer, editor]) {
      expect(withCaller(as(user), () => docs.getDocumentation(folder.id).publication?.id)).toBe(
        publication.id,
      );
      expect(() =>
        withCaller(as(user), () =>
          docs.publishDocumentation(folder.id, { visibility: "public", expectedRevision: 1 }),
        ),
      ).toThrow(/role/);
      expect(docs.visibleDocumentation(publication.id, as(user)).id).toBe(publication.id);
    }
    expect(() => docs.visibleDocumentation(publication.id, as(outsider))).toThrow();
    expect(() => docs.visibleDocumentation(publication.id, null)).toThrow();
    withCaller(as(owner), () =>
      docs.publishDocumentation(folder.id, { visibility: "public", expectedRevision: 1 }),
    );
    expect(docs.visibleDocumentation(publication.id, null).id).toBe(publication.id);
  });
  it("serves private/public HTML and downloads with no-store and a restrictive CSP", async () => {
    const { folder } = setup();
    const publication = withCaller(as(owner), () =>
      docs.publishDocumentation(folder.id, { visibility: "private", expectedRevision: 0 }),
    );
    const { GET } = await import("@/app/api/documentation/[id]/route");
    const ctx = { params: Promise.resolve({ id: publication.id }) };
    expect((await GET(req(undefined, publication.path), ctx)).status).toBe(404);
    expect((await GET(req(outsider, publication.path), ctx)).status).toBe(404);
    const privatePage = await GET(req(viewer, publication.path), ctx);
    expect(privatePage.status).toBe(200);
    expect(privatePage.headers.get("cache-control")).toBe("no-store");
    expect(privatePage.headers.get("content-security-policy")).toContain("script-src 'nonce-");
    withCaller(as(owner), () =>
      docs.publishDocumentation(folder.id, { visibility: "public", expectedRevision: 1 }),
    );
    const publicPage = await GET(req(undefined, publication.path), ctx);
    expect(publicPage.status).toBe(200);
    expect(await publicPage.text()).not.toContain("docs-private-token");
    const exported = await GET(req(undefined, publication.path + "?format=collection"), ctx);
    expect(exported.headers.get("content-disposition")).toContain("attachment");
    expect(JSON.stringify(await exported.json())).not.toContain("docs-private-variable");
    withCaller(as(owner), () => docs.revokeDocumentation(folder.id));
    expect((await GET(req(undefined, publication.path), ctx)).status).toBe(404);
  });
  it("only bypasses the login gate for the exact read route", async () => {
    const { isPublicPath } = await import("@/server/auth");
    expect(isPublicPath("/api/documentation/abc123")).toBe(true);
    expect(isPublicPath("/api/documentation/abc123/import")).toBe(false);
    expect(isPublicPath("/api/folders/abc/documentation")).toBe(false);
  });
  it("imports sanitized data into a writable destination and checks private source access", () => {
    const { folder } = setup();
    const pub = withCaller(as(owner), () =>
      docs.publishDocumentation(folder.id, { visibility: "private", expectedRevision: 0 }),
    );
    const destination = withCaller(as(outsider), () => repo.createWorkspace("Destination"));
    expect(() => withCaller(as(outsider), () => docs.importDocumentation(pub.id, destination.id))).toThrow();
    withCaller(as(owner), () =>
      docs.publishDocumentation(folder.id, { visibility: "public", expectedRevision: 1 }),
    );
    const result = withCaller(as(outsider), () => docs.importDocumentation(pub.id, destination.id));
    expect(result.requests).toBe(1);
    const imported = repo.getFolderTree(result.id)!;
    expect(imported.children[0].preRequestScript).toBe("");
    expect(imported.children[0].auth.type).toBe("none");
    expect(() => withCaller(as(viewer), () => docs.importDocumentation(pub.id, destination.id))).toThrow();
  });
  it("accounts for retained snapshot bytes and revokes publication access on every backup restore", async () => {
    const { ws, folder } = setup();
    const { storageBytes } = await import("@/server/usage");
    const before = storageBytes(ws.id);
    const pub = withCaller(as(owner), () =>
      docs.publishDocumentation(folder.id, { visibility: "public", expectedRevision: 0 }),
    );
    expect(storageBytes(ws.id)).toBeGreaterThan(before);
    const { createBackup, restoreBackup } = await import("@/server/backup");
    const backup = createBackup(getDb(), { includeSecrets: true });
    restoreBackup(getDb(), getSqlite(), JSON.parse(JSON.stringify(backup)));
    expect(() => docs.visibleDocumentation(pub.id, null)).toThrow();
    const next = withCaller(as(owner), () =>
      docs.publishDocumentation(folder.id, { visibility: "public", expectedRevision: 0 }),
    );
    expect(next.id).not.toBe(pub.id);
    withCaller(as(owner), () => repo.deleteFolder(folder.id));
    expect(
      getDb()
        .select()
        .from(schema.documentationPublications)
        .where(eq(schema.documentationPublications.id, next.id))
        .get(),
    ).toBeUndefined();
  });
});
