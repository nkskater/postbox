import { describe, expect, it } from "vitest";
import { readSdkDefinition, structuralType } from "@/core/sdk/source";
import { generateSdk } from "@/core/sdk/generate";
import { sdkOptionsSchema } from "@/core/sdk/model";
import { postmanV21ToV3 } from "@/core/convert/postman-v3";
const collection = {
  info: { name: "API", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
  auth: { type: "bearer", bearer: [{ key: "token", value: "source-auth-secret" }] },
  variable: [{ key: "token", value: "source-variable-secret", type: "secret" }],
  item: [
    {
      name: "Get pet",
      request: {
        method: "GET",
        url: "{{baseUrl}}/pets/{{id}}?token=source-query-secret",
        header: [{ key: "Authorization", value: "Bearer source-auth-secret" }],
      },
      event: [{ listen: "test" as const, script: { exec: ["source-script-secret"] } }],
    },
  ],
};
describe("SDK source normalization", () => {
  it("is stable across random imported ids and omits credentials, defaults, scripts and example values", () => {
    const first = readSdkDefinition(JSON.stringify(collection)),
      second = readSdkDefinition(JSON.stringify(collection));
    expect(first).toEqual(second);
    const artifact = generateSdk(first, { language: "typescript", name: "pet_client", version: "1.0.0" });
    const text = JSON.stringify(artifact.files);
    for (const secret of [
      "source-auth-secret",
      "source-variable-secret",
      "source-query-secret",
      "source-script-secret",
    ])
      expect(text).not.toContain(secret);
    expect(first.operations[0]).toMatchObject({ name: "get_pet", path: "/pets/{id}", authRequired: true });
    expect(artifact.files["package.json"]).not.toContain('"scripts"');
  });
  it("preserves path templates in absolute collection URLs", () => {
    for (const url of [
      "https://example.test/pets/{{id}}",
      "https://example.test/pets/{id}",
      "https://example.test/pets/%7B%7Bid%7D%7D",
    ]) {
      const source = readSdkDefinition(
        JSON.stringify({ ...collection, item: [{ name: "Get pet", request: { method: "GET", url } }] }),
      );
      expect(source.operations[0]).toMatchObject({ path: "/pets/{id}", pathParameters: ["id"] });
    }
  });
  it("supports Postman v3 and YAML OpenAPI with local structural schemas", () => {
    const v3 = postmanV21ToV3(collection).collection;
    expect(readSdkDefinition(JSON.stringify(v3)).operations[0].path).toBe("/pets/{id}");
    const yaml =
      'openapi: 3.0.3\ninfo: {title: API, version: 1.0.0}\npaths:\n  /pets:\n    get:\n      operationId: listPets\n      responses:\n        "200":\n          description: OK\n          content:\n            application/json:\n              schema: {type: array, items: {$ref: "#/components/schemas/Pet"}}\ncomponents:\n  schemas:\n    Pet:\n      type: object\n      required: [id]\n      properties:\n        id: {type: integer}\n';
    const source = readSdkDefinition(yaml);
    expect(source.operations[0].responseType).toMatchObject({
      kind: "array",
      items: { kind: "object", required: ["id"] },
    });
  });
  it("keeps operation names from shadowing client configuration attributes", () => {
    const value = {
      ...collection,
      item: ["auth", "headers", "transport", "pages", "for", "lambda"].map((name) => ({
        name,
        request: { method: "GET", url: "https://example.test/" + name },
      })),
    };
    expect(readSdkDefinition(JSON.stringify(value)).operations.map((operation) => operation.name)).toEqual([
      "op_auth",
      "op_headers",
      "op_transport",
      "op_pages",
      "op_for",
      "op_lambda",
    ]);
  });
  it("projects types without retaining schema defaults, enum literals or executable/source content", () => {
    const type = structuralType({
      type: "object",
      required: ["name"],
      properties: { name: { type: "string", enum: ["schema-secret-value"], default: "default-secret" } },
    });
    expect(JSON.stringify(type)).not.toContain("secret");
    expect(type).toMatchObject({
      kind: "object",
      required: ["name"],
      properties: { name: { kind: "string" } },
    });
  });
  it("rejects remote references, unsupported protocols/uploads and invalid source/package options", () => {
    const remote = {
      openapi: "3.0.3",
      info: { title: "A", version: "1.0.0" },
      paths: {
        "/x": {
          get: {
            responses: {
              200: {
                content: { "application/json": { schema: { $ref: "https://example.invalid/schema" } } },
              },
            },
          },
        },
      },
    };
    expect(() => readSdkDefinition(JSON.stringify(remote))).toThrow();
    expect(() =>
      readSdkDefinition(
        JSON.stringify({
          ...collection,
          item: [{ name: "WS", request: { method: "GET", url: "ws://example.test" } }],
        }),
      ),
    ).toThrow(/HTTP/);
    expect(() =>
      readSdkDefinition(
        JSON.stringify({
          ...collection,
          item: [
            {
              name: "Upload",
              request: {
                method: "POST",
                url: "https://example.test/upload",
                body: { mode: "file", file: { src: "private.bin" } },
              },
            },
          ],
        }),
      ),
    ).toThrow(/unsupported/);
    expect(() => readSdkDefinition("x".repeat(2 * 1024 * 1024 + 1))).toThrow(/2 MiB/);
    for (const name of ["../secret", "json", "typing", "random", "class", "node_modules"]) {
      expect(sdkOptionsSchema.safeParse({ name, language: "python", version: "1.0.0" }).success).toBe(false);
    }
    expect(sdkOptionsSchema.safeParse({ language: "ruby", version: "1.0.0" }).success).toBe(false);
  });
});
