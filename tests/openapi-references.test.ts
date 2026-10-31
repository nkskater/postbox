import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  bundleOpenApiReferences,
  OpenApiResolutionError,
  normalizeBundlePath,
  localReferenceValue,
} from "@/core/convert/openapi-references";
import { importOpenApi, sampleFromSchema } from "@/core/convert/openapi";
import type { FolderNode, RequestNode } from "@/core/types";
const fixturePaths = ["openapi.yaml", "paths/pets.yaml", "models/pet.yaml", "shared/common.json"];
const bundleFiles = () =>
  fixturePaths.map((path) => ({
    path: `project/${path}`,
    content: fs.readFileSync(new URL(`./fixtures/openapi/${path}`, import.meta.url), "utf8"),
  }));
const spec = (schema: unknown) =>
  JSON.stringify({
    openapi: "3.1.0",
    info: { title: "Refs" },
    paths: { "/pets": { post: { requestBody: { content: { "application/json": { schema } } } } } },
  });
const requests = (node: FolderNode): RequestNode[] =>
  node.children.flatMap((child) => (child.kind === "request" ? [child] : requests(child)));
const errors = async (promise: Promise<unknown>) => {
  try {
    await promise;
    throw new Error("Expected resolution failure");
  } catch (error) {
    expect(error).toBeInstanceOf(OpenApiResolutionError);
    return (error as OpenApiResolutionError).diagnostics;
  }
};

describe("bounded OpenAPI reference bundling", () => {
  it("resolves uploaded YAML/JSON paths, parameters, schemas, anchors and security without losing source URL/server precedence", async () => {
    const result = await bundleOpenApiReferences({
      files: bundleFiles(),
      entrypoint: "project/openapi.yaml",
      sourceUrl: "https://api.example/spec/openapi.yaml?key=hidden",
    });
    expect(result.summary).toMatchObject({ documents: 4, remoteFetches: 0, providedFiles: 4 });
    expect(result.diagnostics.some((d) => d.code === "cyclic-reference")).toBe(true);
    expect(JSON.stringify(result.diagnostics)).not.toContain("hidden");
    const converted = importOpenApi(result.document, { sourceUrl: result.sourceUrl });
    const all = requests(converted.root);
    expect(all).toHaveLength(2);
    expect(converted.variables.find((v) => v.key === "baseUrl")?.value).toBe("https://api.example/api");
    expect(converted.variables.some((v) => v.value === "https://api.example/spec/v2")).toBe(true);
    expect(converted.variables.find((v) => v.key === "id")?.value).toBe("7");
    expect(converted.root.auth).toMatchObject({ type: "bearer" });
    const create = all.find((r) => r.method === "POST")!;
    expect(create.body.mode).toBe("raw");
    if (create.body.mode === "raw") {
      expect(JSON.parse(create.body.raw)).toMatchObject({ name: "Mochi 🐾", metadata: { $ref: "literal" } });
      expect(create.body.raw.length).toBeLessThan(4000);
    }
  });
  it("fails missing and external synchronous refs rather than substituting empty objects", () => {
    expect(() => importOpenApi(JSON.parse(spec({ $ref: "./models.yaml#/Pet" })))).toThrow(/External OpenAPI/);
    expect(() => sampleFromSchema({}, { $ref: "#/missing" })).toThrow(/Missing/);
    expect(() => localReferenceValue({ a: { $ref: "#/a" } }, { $ref: "#/a" })).toThrow(/Cyclic/);
  });
  it("decodes escaped/percent JSON pointers and keeps literal example references opaque", async () => {
    const load = vi.fn();
    const root = JSON.parse(spec({ $ref: "parts.json#/escaped~1name~0" }));
    root.components = { examples: { Literal: { $ref: "parts.json#/example" } } };
    const result = await bundleOpenApiReferences({
      files: [
        { path: "root.json", content: JSON.stringify(root) },
        { path: "parts.json", content: bundleFiles()[3].content },
      ],
      entrypoint: "root.json",
      loadRemote: load,
    });
    expect(load).not.toHaveBeenCalled();
    const body = requests(importOpenApi(result.document).root)[0].body;
    expect(body).toMatchObject({ mode: "raw", raw: '"escaped"' });
    const pointer = await bundleOpenApiReferences({
      content: JSON.stringify({
        ...JSON.parse(spec({ $ref: "#/components/schemas/a%20b" })),
        components: { schemas: { "a b": { type: "integer", default: 9 } } },
      }),
    });
    expect(requests(importOpenApi(pointer.document).root)[0].body).toMatchObject({ raw: "9" });
  });
  it("preserves external null examples and diagnoses colliding uploaded source URIs", async () => {
    const root = JSON.parse(spec({ type: "string" }));
    root.paths["/pets"].post.requestBody.content["application/json"].examples = {
      first: { $ref: "example.json#/Null" },
    };
    const result = await bundleOpenApiReferences({
      files: [
        { path: "openapi.json", content: JSON.stringify(root) },
        { path: "example.json", content: '{"Null":{"value":null}}' },
      ],
      entrypoint: "openapi.json",
    });
    expect(requests(importOpenApi(result.document).root)[0].body).toMatchObject({ raw: "null" });
    expect(
      (
        await errors(
          bundleOpenApiReferences({
            files: [
              { path: "openapi.json", content: spec({}) },
              { path: "main.json", content: "{}" },
            ],
            entrypoint: "openapi.json",
            sourceUrl: "https://api.example/main.json",
          }),
        )
      )[0].code,
    ).toBe("duplicate-source");
  });
  it("requires explicit origin approval and caches repeated remote references", async () => {
    const content = spec({
      type: "object",
      properties: {
        a: { $ref: "https://schema.example/types.json#/Name" },
        b: { $ref: "https://schema.example/types.json#/Name" },
      },
    });
    const load = vi.fn(async () => ({
      content: JSON.stringify({ Name: { type: "string", default: "remote" } }),
    }));
    expect((await errors(bundleOpenApiReferences({ content, loadRemote: load })))[0]).toMatchObject({
      code: "origin-not-approved",
      origin: "https://schema.example",
    });
    expect(load).not.toHaveBeenCalled();
    const result = await bundleOpenApiReferences({
      content,
      allowedRefOrigins: ["https://schema.example"],
      loadRemote: load,
    });
    expect(load).toHaveBeenCalledTimes(1);
    expect(result.summary.remoteFetches).toBe(1);
    expect(requests(importOpenApi(result.document).root)[0].body).toMatchObject({
      raw: '{\n  "a": "remote",\n  "b": "remote"\n}',
    });
  });
  it("uses each redirected document URL for nested references and schema $id bases", async () => {
    const load = vi.fn(async (uri: string) =>
      uri.endsWith("start.yaml")
        ? {
            content: '$id: nested/model.yaml\ntype: object\nproperties:\n  name: {$ref: "names.json#/Name"}',
            sourceUrl: "https://schema.example/v2/model.yaml",
          }
        : { content: '{"Name":{"type":"string","default":"nested"}}' },
    );
    const result = await bundleOpenApiReferences({
      content: spec({ $ref: "https://schema.example/start.yaml" }),
      allowedRefOrigins: ["https://schema.example"],
      loadRemote: load,
    });
    expect(load.mock.calls.map((c) => c[0])).toEqual([
      "https://schema.example/start.yaml",
      "https://schema.example/v2/nested/names.json",
    ]);
    expect(requests(importOpenApi(result.document).root)[0].body).toMatchObject({
      raw: '{\n  "name": "nested"\n}',
    });
  });
  it("keeps 3.1 schema assertion siblings and warns for ignored 3.0 siblings", async () => {
    for (const version of ["3.1.0", "3.0.3"]) {
      const root = JSON.parse(
        spec({ $ref: "#/components/schemas/Base", properties: { b: { type: "integer", default: 2 } } }),
      );
      root.openapi = version;
      root.components = {
        schemas: { Base: { type: "object", properties: { a: { type: "integer", default: 1 } } } },
      };
      const result = await bundleOpenApiReferences({ content: JSON.stringify(root) });
      const body = requests(importOpenApi(result.document).root)[0].body;
      expect(body.mode).toBe("raw");
      if (body.mode === "raw")
        expect(JSON.parse(body.raw)).toEqual(version === "3.1.0" ? { a: 1, b: 2 } : { a: 1 });
      expect(result.diagnostics.some((d) => d.code === "reference-siblings-ignored")).toBe(
        version === "3.0.3",
      );
    }
  });
  it("keeps primitive and array samples when 3.1 reference siblings add assertions", async () => {
    for (const [base, assertion, expected] of [
      [{ type: "string" }, { minLength: 2 }, "string"],
      [{ type: "array", items: { type: "integer" } }, { minItems: 1 }, [0]],
    ] as const) {
      const root = JSON.parse(spec({ $ref: "#/components/schemas/Base", ...assertion }));
      root.components = { schemas: { Base: base } };
      const result = await bundleOpenApiReferences({ content: JSON.stringify(root) });
      const body = requests(importOpenApi(result.document).root)[0].body;
      if (body.mode !== "raw") throw new Error("Expected JSON sample");
      expect(JSON.parse(body.raw)).toEqual(expected);
    }
  });
  it("reports every missing reference and refuses file:// or unsupported dynamic resolution", async () => {
    for (const [ref, code] of [
      ["missing.yaml#/Pet", "missing-file"],
      ["file:///etc/passwd", "missing-file"],
      ["#/absent", "missing-reference"],
      ["#anchor", "missing-anchor"],
    ])
      expect((await errors(bundleOpenApiReferences({ content: spec({ $ref: ref }) })))[0].code).toBe(code);
    expect((await errors(bundleOpenApiReferences({ content: spec({ $dynamicRef: "#node" }) })))[0].code).toBe(
      "unsupported-dynamic-reference",
    );
    const root = spec({ type: "object", properties: { a: { $ref: "#/a" }, b: { $ref: "#/b" } } });
    expect(
      (await errors(bundleOpenApiReferences({ content: root }))).filter(
        (d) => d.code === "missing-reference",
      ),
    ).toHaveLength(2);
  });
  it("bounds documents, files, graph depth, nodes, references, bytes, time and diagnostics", async () => {
    const cases = [
      { limits: { maxDocumentBytes: 10 }, content: spec({}), code: "document-size" },
      { limits: { maxTotalBytes: 10 }, content: spec({}), code: "total-size" },
      { limits: { maxDepth: 2 }, content: spec({}), code: "depth-limit" },
      { limits: { maxNodes: 2 }, content: spec({}), code: "node-limit" },
      {
        limits: { maxReferences: 1 },
        content: spec({ type: "object", properties: { a: { $ref: "#/info" }, b: { $ref: "#/info" } } }),
        code: "reference-limit",
      },
    ];
    for (const { code, ...options } of cases)
      expect((await errors(bundleOpenApiReferences(options))).some((d) => d.code === code)).toBe(true);
    expect(
      (
        await errors(
          bundleOpenApiReferences({
            files: bundleFiles(),
            entrypoint: "project/openapi.yaml",
            limits: { maxFiles: 1 },
          }),
        )
      )[0].code,
    ).toBe("file-limit");
    const controller = new AbortController();
    controller.abort();
    expect(
      (await errors(bundleOpenApiReferences({ content: spec({}), signal: controller.signal })))[0].code,
    ).toBe("time-limit");
    expect(
      (
        await errors(
          bundleOpenApiReferences({
            content: spec({ type: "object", properties: { a: { $ref: "#/a" }, b: { $ref: "#/b" } } }),
            limits: { maxDiagnostics: 1 },
          }),
        )
      )[0].code,
    ).toBe("diagnostics-truncated");
  });
  it("bounds remote fetches, loaded documents, reference chains and elapsed resolution time", async () => {
    const content = spec({ $ref: "https://schemas.example/one.json" });
    const loadRemote = async (address: string) => ({
      content: address.endsWith("one.json") ? ' {"$ref":"two.json"}' : '{"type":"string"}',
    });
    for (const [limits, code] of [
      [{ maxFetches: 1 }, "fetch-limit"],
      [{ maxFiles: 2 }, "document-limit"],
      [{ maxReferenceDepth: 1 }, "reference-depth"],
    ] as const) {
      expect(
        (
          await errors(
            bundleOpenApiReferences({
              content,
              allowedRefOrigins: ["https://schemas.example"],
              loadRemote,
              limits,
            }),
          )
        ).some((d) => d.code === code),
      ).toBe(true);
    }
    expect(
      (
        await errors(
          bundleOpenApiReferences({
            content,
            allowedRefOrigins: ["https://schemas.example"],
            limits: { timeoutMs: 1 },
            loadRemote: async () => {
              await new Promise((resolve) => setTimeout(resolve, 10));
              return { content: '{"type":"string"}' };
            },
          }),
        )
      ).some((d) => d.code === "time-limit"),
    ).toBe(true);
  });
  it("resolves Swagger 2 external definitions and parameters without changing its scheme precedence", async () => {
    const content = JSON.stringify({
      swagger: "2.0",
      info: { title: "Swagger" },
      host: "api.example",
      basePath: "/v1",
      schemes: ["https"],
      paths: {
        "/pets": {
          post: {
            schemes: ["http"],
            parameters: [{ $ref: "parts.json#/body" }],
            responses: { 200: { description: "OK" } },
          },
        },
      },
    });
    const result = await bundleOpenApiReferences({
      files: [
        { path: "swagger.json", content },
        {
          path: "parts.json",
          content: JSON.stringify({
            body: { name: "body", in: "body", schema: { $ref: "#/Pet" } },
            Pet: { type: "object", properties: { name: { type: "string", default: "Swagger pet" } } },
          }),
        },
      ],
      entrypoint: "swagger.json",
    });
    const converted = importOpenApi(result.document);
    expect(converted.variables.map((v) => v.value)).toEqual([
      "https://api.example/v1",
      "http://api.example/v1",
    ]);
    expect(requests(converted.root)[0].body).toMatchObject({ raw: '{\n  "name": "Swagger pet"\n}' });
  });
  it("bounds recursive sample fan-out and large example expansion before persistence", async () => {
    const recursive = {
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: 8 }, (_, i) => [`child${i}`, { $ref: "#/components/schemas/Node" }]),
      ),
    };
    const root = JSON.parse(spec({ $ref: "#/components/schemas/Node" }));
    root.components = { schemas: { Node: recursive } };
    const bundled = await bundleOpenApiReferences({ content: JSON.stringify(root) });
    expect(() => importOpenApi(bundled.document)).toThrow(/sample expansion/);
    const repeated = JSON.parse(spec({}));
    repeated.paths["/pets"].post.requestBody.content["application/json"].example = Object.fromEntries(
      Array.from({ length: 100 }, (_, i) => [i, "x".repeat(60_000)]),
    );
    expect(() => importOpenApi(repeated)).toThrow(/generated body limit/);
    const largeOperation = {
      post: { requestBody: { content: { "application/json": { example: "x".repeat(1024 * 1024) } } } },
    };
    const total = {
      openapi: "3.1.0",
      paths: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`/path${i}`, largeOperation])),
    };
    expect(() => importOpenApi(total)).toThrow(/converted request content/);
  });
  it("validates bundle paths, duplicates, entrypoint, origin syntax and YAML alias cycles", async () => {
    expect(normalizeBundlePath("project\\models\\pet.yaml")).toBe("project/models/pet.yaml");
    for (const path of ["../secret", "/etc/passwd", "C:\\secret", "x/../a", ""])
      expect(() => normalizeBundlePath(path)).toThrow();
    expect(
      (
        await errors(
          bundleOpenApiReferences({
            files: [
              { path: "a", content: "" },
              { path: "a", content: "" },
            ],
            entrypoint: "a",
          }),
        )
      )[0].code,
    ).toBe("duplicate-file");
    expect(
      (await errors(bundleOpenApiReferences({ files: [{ path: "a", content: "" }], entrypoint: "b" })))[0]
        .code,
    ).toBe("missing-entrypoint");
    expect(
      (
        await errors(
          bundleOpenApiReferences({ content: spec({}), allowedRefOrigins: ["https://x.test/path"] }),
        )
      )[0].code,
    ).toBe("invalid-origin");
    expect(
      (await errors(bundleOpenApiReferences({ content: "openapi: 3.1.0\npaths: &a\n  self: *a" })))[0].code,
    ).toBe("yaml-cycle");
  });
});
