import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { Caller } from "@/server/caller";
import type { UserRow } from "@/server/db/schema";
import { catalogPublishSchema, catalogSearchSchema } from "@/core/catalog/model";
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-catalog-"));
process.env.DATABASE_PATH = path.join(directory, "test.db");
const repo = await import("@/server/repo"),
  catalog = await import("@/server/catalog"),
  users = await import("@/server/users");
const { getDb, getSqlite, schema } = await import("@/server/db");
const { withCaller } = await import("@/server/access-context");
const { setMember } = await import("@/server/authorize");
const as = (user: UserRow): Caller => ({ kind: "user", user, via: "token" });
let owner: UserRow, viewer: UserRow, editor: UserRow, outsider: UserRow;
const tokens: Record<string, string> = {};
beforeAll(async () => {
  owner = await users.createUser({ username: "catalog-owner", password: "password123" });
  viewer = await users.createUser({ username: "catalog-viewer", password: "password123" });
  editor = await users.createUser({ username: "catalog-editor", password: "password123" });
  outsider = await users.createUser({ username: "catalog-outsider", password: "password123" });
  for (const user of [owner, viewer, editor, outsider])
    tokens[user.id] = users.createToken(user.id, "test").token;
});
afterAll(() => {
  getSqlite().close();
  fs.rmSync(directory, { recursive: true, force: true });
});
const setup = () =>
  withCaller(as(owner), () => {
    const ws = repo.createWorkspace("Catalog source");
    setMember(ws.id, viewer.username, "viewer");
    setMember(ws.id, editor.username, "editor");
    const folder = repo.createFolder(ws.id, null, {
      name: "Pets",
      auth: { type: "bearer", bearer: { token: "catalog-auth-secret" } },
    });
    const request = repo.createRequest(ws.id, folder.id, {
      name: "Get pet",
      url: "https://example.test/pets",
      description: "Version one endpoint",
      preRequestScript: 'throw new Error("must-not-execute")',
      body: {
        mode: "raw",
        language: "json",
        raw: JSON.stringify({ token: "catalog-body-secret", name: "opaque-unindexed-body" }),
      },
    });
    repo.replaceVariables(ws.id, "collection", folder.id, [
      { key: "apiKey", value: "catalog-variable-secret", type: "secret", enabled: true },
    ]);
    return { ws, folder, request };
  });
const input = (
  visibility: "private" | "team" | "public" = "private",
  expectedRevision = 0,
  label = "1.0.0",
) => ({
  title: "Pet API",
  description: "A searchable pet API",
  tags: ["pets"],
  owners: ["Platform team"],
  visibility,
  expectedRevision,
  label,
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
describe("catalog access, immutable versions and discovery", () => {
  it("enforces private/team/public access before search counts, matching and pagination", () => {
    const { ws } = setup();
    const entries = withCaller(as(owner), () =>
      ["private", "team", "public"].map((visibility, i) => {
        const folder = repo.createFolder(ws.id, null, { name: visibility });
        repo.createRequest(ws.id, folder.id);
        return catalog.publishCatalog(folder.id, {
          ...input(visibility as "private" | "team" | "public"),
          title: `${visibility} entry`,
          tags: ["visibility-fixture"],
          description: visibility === "private" ? "private-needle" : "visible",
        });
      }),
    );
    const find = (caller: Caller | null) =>
      catalog.searchCatalog({ tag: "visibility-fixture", limit: 1 }, caller);
    expect(find(null).total).toBe(1);
    expect(find(as(outsider)).total).toBe(1);
    expect(find(as(viewer)).total).toBe(2);
    expect(find(as(owner)).total).toBe(3);
    expect(catalog.searchCatalog({ tag: "visibility-fixture", query: "private-needle" }, null).total).toBe(0);
    expect(
      catalog.searchCatalog({ tag: "visibility-fixture", query: "private-needle" }, as(viewer)).total,
    ).toBe(0);
    expect(catalog.searchCatalog({ tag: "visibility-fixture", offset: 1, limit: 1 }, null).entries).toEqual(
      [],
    );
    expect(() => catalog.getCatalogEntry(entries[0].id, undefined, as(viewer))).toThrow();
    expect(() => catalog.getCatalogEntry(entries[1].id, undefined, as(outsider))).toThrow();
    expect(catalog.getCatalogEntry(entries[1].id, undefined, as(editor)).visibility).toBe("team");
    expect(catalog.getCatalogEntry(entries[2].id, undefined, null).visibility).toBe("public");
  });
  it("keeps labels and old content immutable, and rejects duplicate labels/stale edits", () => {
    const { folder, request } = setup();
    withCaller(as(owner), () => {
      const first = catalog.publishCatalog(folder.id, input("public"));
      repo.updateRequest(request.id, { description: "Version two endpoint" });
      const next = catalog.publishCatalog(folder.id, input("public", 1, "2.0.0"));
      expect(next.id).toBe(first.id);
      expect(next.latestVersion).toBe(2);
      expect(JSON.stringify(catalog.getCatalogEntry(first.id, 1, null).snapshot)).toContain(
        "Version one endpoint",
      );
      expect(JSON.stringify(catalog.getCatalogEntry(first.id, 2, null).snapshot)).toContain(
        "Version two endpoint",
      );
      expect(() => catalog.publishCatalog(folder.id, input("public", 2, "1.0.0"))).toThrow(/immutable/);
      expect(() => catalog.publishCatalog(folder.id, input("public", 0, "3.0.0"))).toThrow(/changed/);
      expect(() => catalog.updateCatalog(folder.id, input("private", 1))).toThrow(/changed/);
      expect(() => catalog.getCatalogEntry(first.id, 3, null)).toThrow();
    });
  });
  it("changes sharing across every version and revokes read/search/export/import access", () => {
    const { folder } = setup();
    withCaller(as(owner), () => {
      const entry = catalog.publishCatalog(folder.id, { ...input("public"), tags: ["revoke-fixture"] });
      const updated = catalog.updateCatalog(folder.id, { ...input("team", 1), tags: ["revoke-fixture"] });
      expect(updated.latestVersion).toBe(1);
      expect(updated.revision).toBe(2);
      expect(() => catalog.getCatalogEntry(entry.id, 1, null)).toThrow();
      expect(catalog.searchCatalog({ tag: "revoke-fixture" }, null).total).toBe(0);
      expect(catalog.getCatalogEntry(entry.id, 1, as(viewer)).label).toBe("1.0.0");
      catalog.revokeCatalog(folder.id);
      expect(() => catalog.exportCatalog(entry.id, 1, as(owner))).toThrow();
      expect(catalog.searchCatalog({ tag: "revoke-fixture" }, as(owner)).total).toBe(0);
      const fresh = catalog.publishCatalog(folder.id, input("public"));
      expect(fresh.id).not.toBe(entry.id);
    });
  });
  it("allows read-only team consumers but restricts mutations to full-scope workspace owners", async () => {
    const { folder } = setup();
    const entry = withCaller(as(owner), () => catalog.publishCatalog(folder.id, input("team")));
    for (const user of [viewer, editor]) {
      expect(withCaller(as(user), () => catalog.getFolderCatalog(folder.id).canPublish)).toBe(false);
      expect(() =>
        withCaller(as(user), () => catalog.publishCatalog(folder.id, input("public", 1, "2.0.0"))),
      ).toThrow(/role/);
      expect(() => withCaller(as(user), () => catalog.revokeCatalog(folder.id))).toThrow(/role/);
    }
    const scoped = users.createToken(owner.id, "read-only", null, { scope: "read" });
    const { PUT } = await import("@/app/api/folders/[id]/catalog/route");
    const response = await PUT(
      new Request(`http://localhost/api/folders/${folder.id}/catalog`, {
        method: "PUT",
        headers: { authorization: `Bearer ${scoped.token}`, "content-type": "application/json" },
        body: JSON.stringify(input("public", 1, "2.0.0")),
      }),
      { params: Promise.resolve({ id: folder.id }) },
    );
    expect(response.status).toBe(403);
    expect(catalog.getCatalogEntry(entry.id, 1, as(viewer)).version).toBe(1);
  });
  it("does not index snapshot bodies and redacts credentials from content and metadata", () => {
    const { folder } = setup();
    withCaller(as(owner), () => {
      const entry = catalog.publishCatalog(folder.id, {
        ...input("public"),
        title: "Pet catalog-variable-secret",
        description: "catalog-auth-secret",
        owners: ["catalog-body-secret"],
        tags: ["catalog-variable-secret", "metadata-fixture"],
      });
      const doc = catalog.getCatalogEntry(entry.id, 1, null);
      const serialized = JSON.stringify(doc);
      for (const secret of [
        "catalog-auth-secret",
        "catalog-body-secret",
        "catalog-variable-secret",
        "must-not-execute",
      ])
        expect(serialized).not.toContain(secret);
      expect(doc.tags).toEqual(["metadata-fixture"]);
      expect(
        catalog.searchCatalog({ query: "opaque-unindexed-body", tag: "metadata-fixture" }, null).total,
      ).toBe(0);
      expect(JSON.stringify(catalog.searchCatalog({ tag: "metadata-fixture" }, null))).not.toContain(
        "snapshot",
      );
    });
  });
  it("treats LIKE wildcards as literal query text and uses the visibility index", () => {
    const { folder } = setup();
    withCaller(as(owner), () =>
      catalog.publishCatalog(folder.id, {
        ...input("public"),
        title: "100%_literal! API",
        tags: ["wildcard-fixture"],
      }),
    );
    expect(catalog.searchCatalog({ query: "%_literal!", tag: "wildcard-fixture" }, null).total).toBe(1);
    expect(catalog.searchCatalog({ query: "%_unknown", tag: "wildcard-fixture" }, null).total).toBe(0);
    const plan = getSqlite()
      .prepare(
        "EXPLAIN QUERY PLAN SELECT id FROM catalog_entries WHERE visibility = ? ORDER BY updated_at DESC",
      )
      .all("public");
    expect(JSON.stringify(plan)).toContain("catalog_visibility_updated_idx");
  });
  it("forks the selected version into a writable destination without modifying source or carrying secrets/scripts", () => {
    const { folder, request } = setup();
    const destination = withCaller(as(outsider), () => repo.createWorkspace("Destination"));
    let id = "";
    withCaller(as(owner), () => {
      id = catalog.publishCatalog(folder.id, input("public")).id;
      repo.updateRequest(request.id, { description: "Later version" });
      catalog.publishCatalog(folder.id, input("public", 1, "2.0.0"));
    });
    const result = withCaller(as(outsider), () => catalog.importCatalog(id, destination.id, 1));
    expect(result.source).toMatchObject({ entryId: id, version: 1, label: "1.0.0" });
    const copy = repo.getFolderTree(result.id)!;
    expect(copy.children[0].description).toBe("Version one endpoint");
    expect(copy.children[0].preRequestScript).toBe("");
    expect(copy.children[0].auth.type).toBe("none");
    expect(repo.getRequest(request.id)?.description).toBe("Later version");
    expect(() => withCaller(as(viewer), () => catalog.importCatalog(id, destination.id, 1))).toThrow();
    withCaller(as(owner), () => catalog.revokeCatalog(folder.id));
    expect(() => withCaller(as(outsider), () => catalog.importCatalog(id, destination.id, 1))).toThrow();
  });
  it("pins versions in HTML download/import/navigation and protects import routes", async () => {
    const { folder } = setup();
    const entry = withCaller(as(owner), () => catalog.publishCatalog(folder.id, input("public")));
    const { GET } = await import("@/app/api/catalog/[id]/route");
    const ctx = { params: Promise.resolve({ id: entry.id }) };
    const response = await GET(req(undefined, `/api/catalog/${entry.id}?format=html&version=1`), ctx);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const html = await response.text();
    expect(html).toContain('href="?format=collection&amp;version=1"');
    expect(html).toContain('aria-label="Catalog versions"');
    expect(html).toContain(",version:1");
    const { isPublicPath } = await import("@/server/auth");
    expect(isPublicPath("/api/catalog")).toBe(true);
    expect(isPublicPath(`/api/catalog/${entry.id}`)).toBe(true);
    expect(isPublicPath(`/api/catalog/${entry.id}/import`)).toBe(false);
  });
  it("revokes restored publications, rotates republished IDs, and counts version storage", async () => {
    const { ws, folder } = setup();
    const { storageBytes } = await import("@/server/usage");
    const before = storageBytes(ws.id);
    const entry = withCaller(as(owner), () => catalog.publishCatalog(folder.id, input("public")));
    expect(storageBytes(ws.id)).toBeGreaterThan(before);
    const { createBackup, restoreBackup } = await import("@/server/backup");
    const backup = createBackup(getDb(), { includeSecrets: true });
    restoreBackup(getDb(), getSqlite(), JSON.parse(JSON.stringify(backup)));
    expect(() => catalog.getCatalogEntry(entry.id, 1, null)).toThrow();
    expect(catalog.searchCatalog({ query: entry.title }, null).total).toBe(0);
    const next = withCaller(as(owner), () => catalog.publishCatalog(folder.id, input("public")));
    expect(next.id).not.toBe(entry.id);
    withCaller(as(owner), () => repo.deleteFolder(folder.id));
    expect(
      getDb().select().from(schema.catalogVersions).where(eq(schema.catalogVersions.entryId, next.id)).all(),
    ).toEqual([]);
  });
  it("enforces retained version limits transactionally while allowing sharing restrictions and revocation", () => {
    const { folder } = setup();
    withCaller(as(owner), () => {
      const entry = catalog.publishCatalog(folder.id, input("public"));
      const snapshot = catalog.getCatalogEntry(entry.id, 1, as(owner)).snapshot;
      getDb().transaction((tx) => {
        for (let version = 2; version <= 64; version++)
          tx.insert(schema.catalogVersions)
            .values({ entryId: entry.id, version, label: `0.0.${version}`, snapshot, createdAt: Date.now() })
            .run();
      });
      expect(() => catalog.publishCatalog(folder.id, input("public", 1, "2.0.0"))).toThrow(/64 retained/);
      expect(catalog.getCatalogEntry(entry.id, 1, null).latestVersion).toBe(1);
      const shared = catalog.updateCatalog(folder.id, input("private", 1));
      expect(shared.visibility).toBe("private");
      expect(() => catalog.getCatalogEntry(entry.id, 1, null)).toThrow();
      catalog.revokeCatalog(folder.id);
      expect(
        getDb()
          .select()
          .from(schema.catalogVersions)
          .where(eq(schema.catalogVersions.entryId, entry.id))
          .all(),
      ).toEqual([]);
    });
  });
  it("serves only authorized discovery results through the public REST index", async () => {
    const { folder } = setup();
    withCaller(as(owner), () =>
      catalog.publishCatalog(folder.id, { ...input("private"), tags: ["rest-index-fixture"] }),
    );
    const { GET } = await import("@/app/api/catalog/route");
    const url = "/api/catalog?tag=rest-index-fixture";
    const anonymous = await GET(req(undefined, url));
    expect(anonymous.status).toBe(200);
    expect((await anonymous.json()).total).toBe(0);
    const member = await GET(req(viewer, url));
    expect((await member.json()).total).toBe(0);
    const allowed = await GET(req(owner, url));
    expect((await allowed.json()).total).toBe(1);
    expect(allowed.headers.get("cache-control")).toBe("no-store");
  });
  it("rejects invalid metadata, version labels and pagination", () => {
    expect(catalogPublishSchema.safeParse({ ...input(), label: "latest" }).success).toBe(false);
    expect(catalogPublishSchema.safeParse({ ...input(), tags: ["Invalid tag"] }).success).toBe(false);
    expect(catalogPublishSchema.safeParse({ ...input(), owners: [] }).success).toBe(false);
    expect(catalogSearchSchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(catalogSearchSchema.safeParse({ offset: -1 }).success).toBe(false);
  });
});
