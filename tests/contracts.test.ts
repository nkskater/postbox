import { describe, expect, it } from "vitest";
import {
  parseContract,
  validateContractRequest,
  validateContractResponse,
  validateDraft,
  validateExample,
} from "@/core/contracts/validate";
import { requestInputSchema } from "@/core/schemas";
import { defaultRequest } from "@/server/defaults";

const errors = (result: { status: string }[]) => result.filter((item) => item.status === "error");
describe("request contracts", () => {
  it("checks optional/required fields, types, enums and bounds without changing observed strings", () => {
    const contract = parseContract({
      parameters: [
        { in: "query", name: "limit", schema: { type: "integer", minimum: 1, maximum: 10 } },
        { in: "header", name: "X-Mode", required: true, schema: { type: "string", enum: ["fast", "slow"] } },
        { in: "query", name: "enabled", schema: { type: "boolean" } },
      ],
    });
    const request = {
      url: "https://example.test?limit=2&enabled=false",
      headers: [["x-mode", "fast"]] as [string, string][],
    };
    expect(errors(validateContractRequest(contract, request))).toEqual([]);
    expect(request.url).toContain("limit=2");
    expect(
      errors(
        validateContractRequest(contract, { url: "https://example.test", headers: [["X-Mode", "slow"]] }),
      ),
    ).toEqual([]);
    expect(
      errors(
        validateContractRequest(contract, { url: "https://example.test?limit=11&enabled=no", headers: [] }),
      ),
    ).toHaveLength(3);
    expect(
      errors(validateContractRequest(contract, { ...request, url: "https://example.test?limit=abc" })),
    ).toHaveLength(1);
  });
  it("validates every repeated scalar and repeated-key arrays", () => {
    const contract = parseContract({
      parameters: [
        { in: "query", name: "n", schema: { type: "integer", minimum: 1 } },
        {
          in: "query",
          name: "tags",
          schema: { type: "array", minItems: 2, items: { type: "string", enum: ["a", "b"] } },
        },
      ],
    });
    expect(
      errors(
        validateContractRequest(contract, { url: "https://e.test?n=1&n=no&tags=a&tags=b", headers: [] }),
      ),
    ).toHaveLength(1);
    expect(
      errors(validateContractRequest(contract, { url: "https://e.test?tags=a", headers: [] })),
    ).toHaveLength(1);
  });
  it("checks path parameters and template shape", () => {
    const contract = parseContract({
      pathTemplate: "/pets/{id}",
      parameters: [{ in: "path", name: "id", required: true, schema: { type: "integer", minimum: 1 } }],
    });
    expect(errors(validateContractRequest(contract, { url: "https://e.test/pets/3", headers: [] }))).toEqual(
      [],
    );
    expect(
      errors(validateContractRequest(contract, { url: "https://e.test/pets/no", headers: [] })),
    ).toHaveLength(1);
    expect(
      errors(validateContractRequest(contract, { url: "https://e.test/other/3", headers: [] })),
    ).toHaveLength(2);
    expect(() => parseContract({ parameters: [{ in: "path", name: "id", schema: true }] })).toThrow(
      /pathTemplate/,
    );
  });
  it("preserves unresolved URL/parameter/body templates as deferred", () => {
    const contract = parseContract({
      parameters: [{ in: "query", name: "n", required: true, schema: { type: "integer" } }],
      requestBody: { type: "object" },
    });
    const request = defaultRequest({
      url: "{{baseUrl}}/pets?n={{n}}",
      body: { mode: "raw", raw: '{"x":{{x}}}', language: "json" },
      contract,
    });
    const original = JSON.stringify(request);
    const result = validateDraft(request);
    expect(result.map((item) => item.status)).toEqual(["deferred", "deferred"]);
    expect(JSON.stringify(request)).toBe(original);
    const encoded = validateContractRequest(contract, { url: "https://e.test?n=%7B%7Bn%7D%7D", headers: [] });
    expect(encoded[0].status).toBe("deferred");
  });
  it("supports local referenced schemas and strict JSON body types", () => {
    const schema = {
      type: "object",
      required: ["pet"],
      properties: { pet: { $ref: "#/$defs/pet" } },
      $defs: {
        pet: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "integer", minimum: 1 } },
          additionalProperties: false,
        },
      },
    };
    const contract = parseContract({ requestBody: schema, responseBody: schema, responseStatus: [200, 201] });
    expect(
      errors(
        validateContractRequest(contract, { url: "https://e.test", headers: [], body: '{"pet":{"id":1}}' }),
      ),
    ).toEqual([]);
    expect(
      errors(validateContractResponse(contract, { status: 200, body: '{"pet":{"id":"1"}}' })),
    ).toHaveLength(1);
    expect(
      errors(validateContractResponse(contract, { status: 400, body: '{"pet":{"id":1}}' })),
    ).toHaveLength(1);
    const parameter = parseContract({
      parameters: [
        {
          in: "query",
          name: "n",
          schema: { $ref: "#/definitions/number", definitions: { number: { type: "integer", maximum: 3 } } },
        },
      ],
    });
    expect(errors(validateContractRequest(parameter, { url: "https://e.test?n=2", headers: [] }))).toEqual(
      [],
    );
  });
  it("reports malformed/missing JSON and incomplete examples without observed secret values", () => {
    const contract = parseContract({
      responseBody: { type: "object", required: ["id"], properties: { id: { type: "integer" } } },
    });
    expect(errors(validateContractResponse(contract, { status: 200, body: "not json" }))).toHaveLength(1);
    expect(errors(validateContractResponse(contract, { status: 200 }))).toHaveLength(1);
    const example = {
      id: "1",
      name: "Pet",
      status: 200,
      statusText: "OK",
      headers: [],
      body: '{"id":"private-observed-value"}',
      createdAt: 1,
    };
    const report = validateExample(contract, example);
    expect(report[0].status).toBe("error");
    expect(JSON.stringify(report)).not.toContain("private-observed-value");
    expect(validateExample(contract, { ...example, truncated: true })[0].status).toBe("deferred");
    expect(validateExample(contract, { ...example, bodyEncoding: "base64" })[0].status).toBe("deferred");
  });
  it("rejects unsupported, remote, unresolved and oversized schemas at the input boundary", () => {
    for (const schema of [
      { $ref: "https://e.test/schema" },
      { $ref: "#/definitions/missing" },
      { type: "nonsense" },
      { pattern: "(a+)+$" },
      { $async: true },
      { format: "email" },
    ]) {
      expect(requestInputSchema.safeParse({ contract: { requestBody: schema } }).success).toBe(false);
    }
    expect(
      requestInputSchema.safeParse({ contract: { requestBody: { description: "x".repeat(65537) } } }).success,
    ).toBe(false);
    expect(requestInputSchema.safeParse({ contract: null }).success).toBe(true);
    expect(() =>
      parseContract({
        parameters: [
          { in: "header", name: "X", schema: true },
          { in: "header", name: "x", schema: true },
        ],
      }),
    ).toThrow(/Duplicate/);
  });
  it("bounds reference expansion and rejects cyclic reference graphs", () => {
    expect(() =>
      parseContract({
        requestBody: { definitions: { cycle: { $ref: "#/definitions/cycle" } }, $ref: "#/definitions/cycle" },
      }),
    ).toThrow(/Cyclic/);
    const definitions: Record<string, unknown> = { leaf: { type: "string" } };
    for (let i = 0; i < 12; i++)
      definitions[`n${i}`] = {
        allOf: [
          { $ref: `#/definitions/${i ? `n${i - 1}` : "leaf"}` },
          { $ref: `#/definitions/${i ? `n${i - 1}` : "leaf"}` },
        ],
      };
    expect(() => parseContract({ requestBody: { definitions, $ref: "#/definitions/n11" } })).toThrow(
      /node limit/,
    );
  });
  it("bounds observed body size and nesting", () => {
    const contract = parseContract({ responseBody: true });
    expect(
      validateContractResponse(contract, { status: 200, body: JSON.stringify("a".repeat(1024 * 1024)) })[0]
        .status,
    ).toBe("deferred");
    expect(
      validateContractResponse(contract, { status: 200, body: "[".repeat(70) + "0" + "]".repeat(70) })[0]
        .status,
    ).toBe("deferred");
  });
});
