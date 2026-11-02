import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { generateOpenApi } from "@/core/specifications/generate-openapi";
import { mergeThreeWay } from "@/core/specifications/merge";
import { defaultFolder, defaultRequest } from "@/server/defaults";
import type { FolderNode } from "@/core/types";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-spec-sync-"));
process.env.DATABASE_PATH = path.join(dir, "test.db");
const repo = await import("@/server/repo"),
  sync = await import("@/server/specification-sync"),
  specs = await import("@/server/specifications"),
  db = await import("@/server/db");
let ws: string;
beforeAll(() => {
  ws = repo.createWorkspace("Sync").id;
});
afterAll(() => {
  db.getSqlite().close();
  fs.rmSync(dir, { recursive: true, force: true });
});
const definition = () => ({
  openapi: "3.0.3",
  info: { title: "Pets", version: "1.0" },
  servers: [{ url: "https://root.example.test/v1" }],
  paths: {
    "/pets": {
      get: {
        operationId: "listPets",
        summary: "List pets",
        responses: {
          "200": {
            description: "OK",
            content: { "application/json": { schema: { type: "array", items: { type: "string" } } } },
          },
        },
      },
    },
  },
});
function create(document: unknown = definition()) {
  return specs.createSpecification({
    workspaceId: ws,
    name: "Pets spec",
    format: "openapi",
    entrypoint: "openapi.json",
    files: [{ path: "openapi.json", content: JSON.stringify(document) }],
  });
}
function save(id: string, change: (document: ReturnType<typeof definition>) => void) {
  const current = specs.getSpecification(id),
    document = JSON.parse(current.files[0].content);
  change(document);
  return specs.saveSpecification(id, {
    expectedRevision: current.revision,
    entrypoint: current.entrypoint,
    files: [{ path: current.entrypoint, content: JSON.stringify(document) }],
  });
}
const requests = (id: string) => {
  const tree = repo.getFolderTree(id)!;
  return tree.children.flatMap((c) =>
    c.kind === "request"
      ? [repo.getRequest(c.id)!]
      : c.children.filter((r) => r.kind === "request").map((r) => repo.getRequest(r.id)!),
  );
};
describe("collection/specification generation and reviewed synchronization", () => {
  it("generates typed parameters, bodies and response examples without credential values", () => {
    const root: FolderNode = {
      ...defaultFolder({ name: "Typed" }),
      kind: "folder",
      children: [
        {
          ...defaultRequest({
            id: "request-typed",
            name: "Create pet",
            method: "POST",
            url: "{{baseUrl}}/pets/{{id}}",
            auth: { type: "bearer", bearer: { token: "literal-secret-token" } },
            headers: [{ key: "Authorization", value: "Bearer literal-secret-token", enabled: true }],
            params: [{ key: "token", value: "query-secret", enabled: true }],
            body: { mode: "raw", language: "json", raw: '{"name":"Pet","password":"body-secret"}' },
            contract: {
              pathTemplate: "/pets/{id}",
              parameters: [
                {
                  in: "path",
                  name: "id",
                  required: true,
                  description: "Pet ID",
                  schema: { type: "integer" },
                },
              ],
              requestBody: { type: "object", properties: { name: { type: "string" } } },
              responseStatus: [201],
              responseBody: { type: "object", properties: { id: { type: "integer" } } },
            },
            examples: [
              {
                id: "e1",
                name: "Created",
                status: 201,
                statusText: "Created",
                headers: [{ key: "Content-Type", value: "application/json", enabled: true }],
                body: '{"id":1}',
                createdAt: 1,
              },
            ],
          }),
          kind: "request",
        },
      ],
    };
    const result = generateOpenApi(root, [
      { key: "baseUrl", value: "https://example.test/v1", enabled: true, type: "default" },
    ]);
    const json = JSON.stringify(result.document);
    for (const secret of ["literal-secret-token", "query-secret", "body-secret"])
      expect(json).not.toContain(secret);
    const op = (result.document.paths as Record<string, Record<string, Record<string, unknown>>>)[
      "/pets/{id}"
    ].post;
    expect(op.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "id", in: "path", schema: { type: "integer" } }),
      ]),
    );
    expect(op.responses).toMatchObject({
      "201": {
        content: {
          "application/json": {
            schema: { properties: { id: { type: "integer" } } },
            examples: { example_e1: { value: { id: 1 } } },
          },
        },
      },
    });
    expect(generateOpenApi(root).document).toEqual(generateOpenApi(root).document);
  });
  it("merges independent fields and requires explicit choices for concurrent changes", () => {
    const result = mergeThreeWay(
      { name: "A", body: "old", extra: 1 },
      { name: "Local", body: "old", extra: 1 },
      { name: "Remote", body: "new", extra: 1 },
    );
    expect(result.value).toEqual({ name: "Local", body: "new", extra: 1 });
    expect(result.conflicts).toHaveLength(1);
    expect(
      mergeThreeWay({ name: "A" }, { name: "Local" }, { name: "Remote" }, { "/name": "take" }).value,
    ).toEqual({ name: "Remote" });
  });
  it("links a generated collection and makes unchanged previews/applies idempotent in both directions", async () => {
    const spec = create(),
      col = await sync.generateCollection(spec.id),
      first = requests(col.id)[0];
    expect(first.url).toBe("{{baseUrl}}/pets");
    expect(first.contract?.responseBody).toMatchObject({ type: "array" });
    for (const direction of ["collection", "specification"] as const) {
      const p = await sync.previewSpecificationSync(spec.id, { folderId: col.id, direction });
      expect(p.conflicts).toEqual([]);
      expect(p.changes).toEqual([]);
      const revision = sync.getCollectionSpecification(col.id)!.revision;
      await sync.applySpecificationSync(spec.id, { folderId: col.id, direction, token: p.token });
      expect(sync.getCollectionSpecification(col.id)!.revision).toBe(revision);
    }
    expect(requests(col.id)[0].id).toBe(first.id);
  });
  it("generates a linked specification from an existing typed collection without changing its representation", async () => {
    const col = repo.createFolder(ws, null, { name: "Existing" }),
      req = repo.createRequest(ws, col.id, {
        name: "Get thing",
        url: "https://example.test/thing",
        testScript: "pm.test('custom',()=>{});",
      });
    const spec = sync.generateSpecification(col.id);
    expect(sync.getCollectionSpecification(col.id)?.specificationId).toBe(spec.id);
    for (const direction of ["collection", "specification"] as const) {
      const p = await sync.previewSpecificationSync(spec.id, { folderId: col.id, direction });
      expect(p.changes).toEqual([]);
      expect(p.conflicts).toEqual([]);
    }
    expect(repo.getRequest(req.id)?.url).toBe("https://example.test/thing");
  });
  it("previews spec drift, updates stable request IDs, and preserves scripts/settings/custom headers", async () => {
    const spec = create(),
      col = await sync.generateCollection(spec.id),
      req = requests(col.id)[0];
    repo.updateRequest(req.id, {
      preRequestScript: "pm.variables.set('x',1)",
      testScript: "pm.test('custom',()=>{})",
      headers: [{ key: "X-Custom", value: "keep", enabled: true }],
      settings: { ...req.settings, timeoutMs: 1234 },
    });
    save(spec.id, (d) => {
      d.paths["/pets"].get.summary = "Remote list";
    });
    const p = await sync.previewSpecificationSync(spec.id, { folderId: col.id, direction: "collection" });
    expect(p.changes.some((c) => c.path.endsWith("/name"))).toBe(true);
    expect(p.conflicts).toEqual([]);
    expect(repo.getRequest(req.id)?.name).toBe("List pets");
    await sync.applySpecificationSync(spec.id, { folderId: col.id, direction: "collection", token: p.token });
    expect(repo.getRequest(req.id)).toMatchObject({
      name: "Remote list",
      preRequestScript: "pm.variables.set('x',1)",
      testScript: "pm.test('custom',()=>{})",
      headers: [{ key: "X-Custom", value: "keep", enabled: true }],
      settings: { timeoutMs: 1234 },
    });
    expect(
      (await sync.previewSpecificationSync(spec.id, { folderId: col.id, direction: "collection" })).inSync,
    ).toBe(true);
  });
  it("blocks stale previews and unresolved conflicts, then applies explicit field choices", async () => {
    const spec = create(),
      col = await sync.generateCollection(spec.id),
      req = requests(col.id)[0];
    const old = await sync.previewSpecificationSync(spec.id, { folderId: col.id, direction: "collection" });
    save(spec.id, (d) => {
      d.paths["/pets"].get.summary = "Remote";
    });
    await expect(
      sync.applySpecificationSync(spec.id, { folderId: col.id, direction: "collection", token: old.token }),
    ).rejects.toThrow("stale");
    repo.updateRequest(req.id, { name: "Local" });
    const p = await sync.previewSpecificationSync(spec.id, { folderId: col.id, direction: "collection" });
    expect(p.conflicts).toHaveLength(1);
    await expect(
      sync.applySpecificationSync(spec.id, { folderId: col.id, direction: "collection", token: p.token }),
    ).rejects.toThrow("Resolve");
    await sync.applySpecificationSync(spec.id, {
      folderId: col.id,
      direction: "collection",
      token: p.token,
      choices: { [p.conflicts[0].path]: "take" },
    });
    expect(repo.getRequest(req.id)?.name).toBe("Remote");
  });
  it("protects customized removed requests and retains unlinked local requests", async () => {
    const spec = create(),
      col = await sync.generateCollection(spec.id),
      req = requests(col.id)[0],
      local = repo.createRequest(ws, col.id, { name: "Local only", url: "https://local.test/" });
    repo.updateRequest(req.id, { testScript: "custom script" });
    save(spec.id, (d) => {
      Reflect.deleteProperty(d.paths, "/pets");
    });
    let p = await sync.previewSpecificationSync(spec.id, { folderId: col.id, direction: "collection" });
    expect(p.conflicts).toHaveLength(1);
    await sync.applySpecificationSync(spec.id, {
      folderId: col.id,
      direction: "collection",
      token: p.token,
      choices: { [p.conflicts[0].path]: "keep" },
    });
    expect(repo.getRequest(req.id)?.testScript).toBe("custom script");
    expect(repo.getRequest(local.id)).toBeTruthy();
    p = await sync.previewSpecificationSync(spec.id, { folderId: col.id, direction: "collection" });
    expect(p.changes).toEqual([]);
  });
  it("syncs collection edits into a new spec version while preserving authored vendor extensions", async () => {
    const definitionWithExtra = { ...definition(), "x-owner": "authors" },
      spec = create(definitionWithExtra),
      col = await sync.generateCollection(spec.id),
      req = requests(col.id)[0];
    repo.updateRequest(req.id, { name: "Collection summary" });
    const p = await sync.previewSpecificationSync(spec.id, { folderId: col.id, direction: "specification" });
    expect(p.conflicts).toEqual([]);
    await sync.applySpecificationSync(spec.id, {
      folderId: col.id,
      direction: "specification",
      token: p.token,
    });
    const doc = specs.getSpecification(spec.id);
    expect(doc.version).toBe(2);
    expect(JSON.parse(doc.files[0].content)).toMatchObject({
      "x-owner": "authors",
      paths: { "/pets": { get: { summary: "Collection summary" } } },
    });
    expect(
      (await sync.previewSpecificationSync(spec.id, { folderId: col.id, direction: "specification" })).inSync,
    ).toBe(true);
    expect(
      (await sync.previewSpecificationSync(spec.id, { folderId: col.id, direction: "collection" })).inSync,
    ).toBe(true);
  });
  it("retains root/path/operation server precedence and relative source URL resolution", async () => {
    const d = definition() as Record<string, unknown>;
    d.servers = [{ url: "../root" }];
    d.paths = {
      "/pets": {
        servers: [{ url: "/path" }],
        get: {
          operationId: "getPets",
          servers: [{ url: "./operation" }],
          responses: { "200": { description: "ok" } },
        },
        post: { operationId: "postPets", responses: { "200": { description: "ok" } } },
      },
      "/other": { get: { responses: { "200": { description: "ok" } } } },
    };
    const spec = create(d),
      col = await sync.generateCollection(spec.id, { sourceUrl: "https://source.test/spec/openapi.json" }),
      vars = repo.listVariables(ws, "collection", col.id);
    expect(vars.map((v) => v.value)).toEqual(
      expect.arrayContaining([
        "https://source.test/root",
        "https://source.test/path",
        "https://source.test/spec/operation",
      ]),
    );
    expect(
      (await sync.previewSpecificationSync(spec.id, { folderId: col.id, direction: "collection" })).inSync,
    ).toBe(true);
  });
});

describe("linked source lifecycle and round-trip edge cases", () => {
  it("preserves named response examples and updates their values without renaming them", async () => {
    const d = definition() as Record<string, unknown>;
    d.paths = {
      "/pets": {
        get: {
          operationId: "listPets",
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": {
                  schema: { type: "object", properties: { name: { type: "string" } } },
                  examples: { pet: { summary: "Pet example", value: { name: "Original" } } },
                },
              },
            },
          },
        },
      },
    };
    const spec = create(d),
      col = await sync.generateCollection(spec.id),
      req = requests(col.id)[0];
    expect(req.examples).toHaveLength(1);
    expect(JSON.parse(req.examples![0].body)).toEqual({ name: "Original" });
    repo.updateRequest(req.id, { examples: [{ ...req.examples![0], body: '{"name":"Changed"}' }] });
    const p = await sync.previewSpecificationSync(spec.id, { folderId: col.id, direction: "specification" });
    expect(p.conflicts).toEqual([]);
    await sync.applySpecificationSync(spec.id, {
      folderId: col.id,
      direction: "specification",
      token: p.token,
    });
    const doc = JSON.parse(specs.getSpecification(spec.id).files[0].content);
    expect(Object.keys(doc.paths["/pets"].get.responses["200"].content["application/json"].examples)).toEqual(
      ["pet"],
    );
    expect(doc.paths["/pets"].get.responses["200"].content["application/json"].examples.pet.value).toEqual({
      name: "Changed",
    });
    expect(
      (await sync.previewSpecificationSync(spec.id, { folderId: col.id, direction: "specification" })).inSync,
    ).toBe(true);
  });
  it("keeps local deletions across unrelated source edits and requires a choice when deleted requests change", async () => {
    const spec = create(),
      col = await sync.generateCollection(spec.id),
      req = requests(col.id)[0];
    repo.deleteRequest(req.id);
    save(spec.id, (d) => {
      d.info.title = "Renamed API";
    });
    let p = await sync.previewSpecificationSync(spec.id, { folderId: col.id, direction: "collection" });
    expect(p.conflicts).toEqual([]);
    await sync.applySpecificationSync(spec.id, { folderId: col.id, direction: "collection", token: p.token });
    expect(requests(col.id)).toHaveLength(0);
    expect(
      (await sync.previewSpecificationSync(spec.id, { folderId: col.id, direction: "collection" })).changes,
    ).toEqual([]);
    save(spec.id, (d) => {
      d.paths["/pets"].get.summary = "Changed deleted request";
    });
    p = await sync.previewSpecificationSync(spec.id, { folderId: col.id, direction: "collection" });
    expect(p.conflicts).toHaveLength(1);
    await sync.applySpecificationSync(spec.id, {
      folderId: col.id,
      direction: "collection",
      token: p.token,
      choices: { [p.conflicts[0].path]: "keep" },
    });
    expect(
      (await sync.previewSpecificationSync(spec.id, { folderId: col.id, direction: "collection" })).changes,
    ).toEqual([]);
    expect(requests(col.id)).toHaveLength(0);
  });
  it("retains link baselines through backup restore and scrubs auth credentials in default exports", async () => {
    const col = repo.createFolder(ws, null, {
      name: "Private collection",
      auth: { type: "bearer", bearer: { token: "backup-sync-secret-token" } },
    });
    repo.createRequest(ws, col.id, { url: "https://example.test/health" });
    sync.generateSpecification(col.id);
    const backup = await import("@/server/backup"),
      payload = backup.createBackup(db.getDb(), { includeSecrets: false }),
      target = db.openDatabase(path.join(dir, "restored.db"));
    expect(JSON.stringify(payload)).not.toContain("backup-sync-secret-token");
    try {
      const restored = backup.restoreBackup(target.db, target.sqlite, JSON.parse(JSON.stringify(payload)));
      expect(restored.specificationLinks).toBeGreaterThan(0);
      expect(target.sqlite.prepare("SELECT count(*) AS n FROM specification_links").get()).toEqual({
        n: restored.specificationLinks,
      });
    } finally {
      target.sqlite.close();
    }
  });
});

describe("bounded schema projections and additions", () => {
  it("describes binary request bodies without exporting uploaded bytes", () => {
    const root: FolderNode = {
      ...defaultFolder({ name: "Upload" }),
      kind: "folder",
      children: [
        {
          ...defaultRequest({
            method: "POST",
            url: "https://example.test/upload",
            body: {
              mode: "binary",
              binary: {
                fileName: "secret.bin",
                contentType: "application/octet-stream",
                data: "private-upload-bytes",
              },
            },
          }),
          kind: "request",
        },
      ],
    };
    const result = generateOpenApi(root);
    expect(JSON.stringify(result.document)).not.toContain("private-upload-bytes");
    expect(
      (result.document.paths as Record<string, Record<string, Record<string, unknown>>>)["/upload"].post
        .requestBody,
    ).toEqual({ content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } } });
  });

  it("bounds repeated reference expansion while retaining the original source", async () => {
    const shapes: Record<string, unknown> = { S0: { type: "string" } };
    for (let i = 1; i <= 15; i++)
      shapes["S" + i] = {
        type: "object",
        properties: {
          left: { $ref: "#/components/schemas/S" + (i - 1) },
          right: { $ref: "#/components/schemas/S" + (i - 1) },
        },
      };
    const d = definition() as Record<string, unknown>;
    d.components = { schemas: shapes };
    d.paths = {
      "/pets": {
        get: {
          responses: {
            "200": {
              description: "OK",
              content: { "application/json": { schema: { $ref: "#/components/schemas/S15" } } },
            },
          },
        },
      },
    };
    const spec = create(d),
      col = await sync.generateCollection(spec.id);
    expect(col.warnings.some((w) => w.includes("2,048"))).toBe(true);
    expect(JSON.parse(specs.getSpecification(spec.id).files[0].content).components.schemas.S15).toBeTruthy();
  });

  it("redacts sensitive query credentials in server variable defaults", () => {
    const root: FolderNode = {
      ...defaultFolder({ name: "Server query" }),
      kind: "folder",
      children: [{ ...defaultRequest({ url: "{{baseUrl}}/health" }), kind: "request" }],
    };
    const result = generateOpenApi(root, [
      {
        key: "baseUrl",
        value: "https://example.test/api?token=server-query-secret",
        enabled: true,
        type: "default",
      },
    ]);
    expect(JSON.stringify(result.document)).not.toContain("server-query-secret");
  });

  it("imports recursive schemas and unsupported formats with explicit warnings", async () => {
    const d = definition() as Record<string, unknown>;
    d.components = {
      schemas: {
        Pet: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            parent: { $ref: "#/components/schemas/Pet" },
          },
        },
      },
    };
    d.paths = {
      "/pets": {
        get: {
          responses: {
            "200": {
              description: "OK",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Pet" } } },
            },
          },
        },
      },
    };
    const spec = create(d),
      col = await sync.generateCollection(spec.id);
    expect(col.warnings.some((w) => /Recursive|format/.test(w))).toBe(true);
    expect(requests(col.id)[0].contract?.responseBody).toBeTruthy();
    expect(
      (await sync.previewSpecificationSync(spec.id, { folderId: col.id, direction: "collection" })).changes,
    ).toEqual([]);
  });
  it("links new collection requests after reverse synchronization", async () => {
    const spec = create(),
      col = await sync.generateCollection(spec.id),
      added = repo.createRequest(ws, col.id, {
        name: "New endpoint",
        url: "https://root.example.test/v1/new",
        method: "POST",
      });
    const p = await sync.previewSpecificationSync(spec.id, { folderId: col.id, direction: "specification" });
    await sync.applySpecificationSync(spec.id, {
      folderId: col.id,
      direction: "specification",
      token: p.token,
    });
    expect(
      (await sync.previewSpecificationSync(spec.id, { folderId: col.id, direction: "collection" })).changes,
    ).toEqual([]);
    const stored = specs.getSpecification(spec.id),
      document = JSON.parse(stored.files[0].content);
    const operation = Object.values(document.paths)
      .flatMap((item) => Object.values(item as Record<string, unknown>))
      .find(
        (op) =>
          !!op &&
          typeof op === "object" &&
          (op as Record<string, unknown>)["x-postbox-request-id"] === added.id,
      );
    expect(operation).toBeTruthy();
  });
});
