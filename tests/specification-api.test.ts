import { beforeAll, afterAll, describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { UserRow } from "@/server/db/schema";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-specification-api-"));
process.env.DATABASE_PATH = path.join(dir, "test.db");
const repo = await import("@/server/repo"),
  users = await import("@/server/users"),
  specs = await import("@/server/specifications"),
  db = await import("@/server/db"),
  backup = await import("@/server/backup");
const { withCaller } = await import("@/server/access-context"),
  { setMember } = await import("@/server/authorize");
let owner: UserRow, viewer: UserRow, editor: UserRow, outsider: UserRow, ws: string;
const tokens: Record<string, string> = {};
const caller = (user: UserRow) => ({ kind: "user" as const, user, via: "token" as const });
beforeAll(async () => {
  owner = await users.createUser({ username: "spec-owner", password: "password123" });
  viewer = await users.createUser({ username: "spec-viewer", password: "password123" });
  editor = await users.createUser({ username: "spec-editor", password: "password123" });
  outsider = await users.createUser({ username: "spec-outsider", password: "password123" });
  for (const u of [owner, viewer, editor, outsider]) tokens[u.id] = users.createToken(u.id, "test").token;
  withCaller(caller(owner), () => {
    ws = repo.createWorkspace("Specifications").id;
    setMember(ws, viewer.username, "viewer");
    setMember(ws, editor.username, "editor");
  });
});
afterAll(() => {
  db.getSqlite().close();
  fs.rmSync(dir, { recursive: true, force: true });
});
async function request(method: string, suffix: string, user: UserRow, body?: unknown, id = "") {
  const mod =
    suffix === "/validate"
      ? await import("@/app/api/specifications/validate/route")
      : id
        ? await import("@/app/api/specifications/[id]/route")
        : await import("@/app/api/specifications/route");
  return (
    mod as Record<string, (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>>
  )[method](
    new Request("http://localhost/api/specifications" + suffix, {
      method,
      headers: { authorization: `Bearer ${tokens[user.id]}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    }),
    { params: Promise.resolve({ id }) },
  ) as Promise<Response>;
}
const source = {
  format: "graphql" as const,
  entrypoint: "schema.graphql",
  files: [{ path: "schema.graphql", content: "type Query { health: String! }" }],
};
describe("specification persistence, versions and workspace access", () => {
  it("enforces editor/viewer/foreign-workspace boundaries for CRUD, export and validation", async () => {
    const body = { ...source, workspaceId: ws, name: "Private API" };
    expect((await request("POST", "", viewer, body)).status).toBe(403);
    const response = await request("POST", "", editor, body);
    expect(response.status, await response.clone().text()).toBe(201);
    const saved = await response.json();
    expect(saved.analysis.valid).toBe(true);
    expect((await request("GET", "?workspaceId=" + ws, viewer)).status).toBe(200);
    expect((await request("GET", "/" + saved.id, outsider, undefined, saved.id)).status).toBe(404);
    expect(
      (await request("PATCH", "/" + saved.id, viewer, { ...source, expectedRevision: 1 }, saved.id)).status,
    ).toBe(403);
    const exportResponse = await request(
      "GET",
      "/" + saved.id + "?export=bundle",
      viewer,
      undefined,
      saved.id,
    );
    expect(exportResponse.status).toBe(200);
    expect(await exportResponse.json()).toEqual(source);
    expect((await request("POST", "/validate", viewer, { ...source, workspaceId: ws })).status).toBe(200);
    expect((await request("POST", "/validate", outsider, { ...source, workspaceId: ws })).status).toBe(404);
    expect((await request("DELETE", "/" + saved.id, viewer, undefined, saved.id)).status).toBe(403);
    expect((await request("DELETE", "/" + saved.id, editor, undefined, saved.id)).status).toBe(200);
    expect((await request("GET", "/" + saved.id, owner, undefined, saved.id)).status).toBe(404);
  });
  it("preserves exact source in immutable versions, accepts invalid drafts, and rejects stale updates", () =>
    withCaller(caller(owner), () => {
      const saved = specs.createSpecification({
        ...source,
        workspaceId: ws,
        name: "Versioned API",
        label: "Initial",
      });
      const invalid = "type Query { broken: }\n";
      const second = specs.saveSpecification(saved.id, {
        expectedRevision: 1,
        entrypoint: source.entrypoint,
        files: [{ path: source.entrypoint, content: invalid }],
        label: "Draft",
      });
      expect(second.revision).toBe(2);
      expect(second.analysis.valid).toBe(false);
      expect(specs.getSpecification(saved.id, 1).files).toEqual(source.files);
      expect(specs.getSpecification(saved.id, 1).label).toBe("Initial");
      expect(specs.getSpecification(saved.id, 2).files[0].content).toBe(invalid);
      expect(() =>
        specs.saveSpecification(saved.id, {
          expectedRevision: 1,
          entrypoint: source.entrypoint,
          files: source.files,
        }),
      ).toThrow("changed");
      expect(() => specs.getSpecification(saved.id, 3)).toThrow("not found");
      expect(() => specs.getSpecification(saved.id, 1.5)).toThrow("Invalid version");
      const restored = specs.saveSpecification(saved.id, {
        expectedRevision: 2,
        entrypoint: source.entrypoint,
        files: specs.getSpecification(saved.id, 1).files,
      });
      expect(restored.version).toBe(3);
      expect(restored.analysis.valid).toBe(true);
    }));
  it("rejects duplicate files, missing entrypoints, oversized UTF-8 and unsafe file paths without persisting", async () => {
    for (const changed of [
      { entrypoint: "missing" },
      { files: [...source.files, ...source.files] },
      { files: [{ path: "schema.graphql", content: "💥".repeat(400000) }] },
      { entrypoint: "../secrets", files: [{ path: "../secrets", content: "" }] },
    ]) {
      const response = await request("POST", "", owner, {
        ...source,
        ...changed,
        workspaceId: ws,
        name: "Invalid files",
      });
      expect(response.status, await response.clone().text()).toBe(400);
    }
  });
  it("includes source and all versions in workspace backups and cascades deletion", () =>
    withCaller(caller(owner), () => {
      const exported = backup.createBackup(db.getDb(), { includeSecrets: true }),
        target = db.openDatabase(path.join(dir, "restore.db"));
      try {
        const result = backup.restoreBackup(target.db, target.sqlite, JSON.parse(JSON.stringify(exported)));
        expect(result.specifications).toBeGreaterThan(0);
        expect(result.specificationVersions).toBeGreaterThan(1);
        expect(target.sqlite.prepare("select count(*) as n from specification_versions").get()).toMatchObject(
          { n: result.specificationVersions },
        );
      } finally {
        target.sqlite.close();
      }
      const saved = specs.createSpecification({ ...source, workspaceId: ws, name: "Delete history" });
      specs.saveSpecification(saved.id, {
        expectedRevision: 1,
        entrypoint: source.entrypoint,
        files: source.files,
      });
      specs.deleteSpecification(saved.id);
      expect(
        db
          .getSqlite()
          .prepare("select count(*) as n from specification_versions where specification_id=?")
          .get(saved.id),
      ).toEqual({ n: 0 });
    }));
});
