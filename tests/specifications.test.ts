import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeSpecification } from "@/core/specifications/analyze";
import { specificationSource, SPEC_LIMITS, type SpecificationFormat } from "@/core/specifications/model";
const fixtures = [
  ["openapi", "openapi.yaml"],
  ["asyncapi", "asyncapi.yaml"],
  ["graphql", "schema.graphql"],
  ["protobuf", "service.proto"],
  ["smithy", "model.smithy"],
] as const;
const fixture = (file: string) =>
  fs.readFileSync(path.join(import.meta.dirname, "fixtures/specifications", file), "utf8");
const analyze = (
  format: SpecificationFormat,
  text: string,
  file = "source.txt",
  extra: { path: string; content: string }[] = [],
) => analyzeSpecification({ format, entrypoint: file, files: [{ path: file, content: text }, ...extra] });
describe("versioned specification format analysis", () => {
  for (const [format, file] of fixtures)
    it(`validates and previews ${format} fixture`, () => {
      const result = analyze(format, fixture(file), file);
      expect(result.diagnostics).toEqual([]);
      expect(result.valid).toBe(true);
      expect(result.symbols.length).toBeGreaterThan(0);
      expect(result.symbols.every((s) => s.file && s.line >= 1 && s.column >= 1)).toBe(true);
    });
  it("retains YAML source locations, resolves multi-file pointers and reports remote/missing references without fetching", () => {
    const result = analyze(
      "openapi",
      fixture("openapi.yaml") +
        '\n  responses:\n    Pet:\n      $ref: "models/pet.yaml#/Pet"\n    Missing:\n      $ref: "https://example.invalid/pet.json"\n',
      "api.yaml",
      [{ path: "models/pet.yaml", content: "Pet:\n  type: string\n" }],
    );
    expect(result.references).toHaveLength(2);
    expect(result.references[0]).toMatchObject({ resolved: true, file: "api.yaml", line: 22 });
    expect(result.references[1].resolved).toBe(false);
    expect(result.diagnostics[0].code).toBe("reference");
  });
  it("supports relative sibling references and cyclic schema references without recursive expansion", () => {
    const result = analyze(
      "openapi",
      'openapi: 3.0.3\ninfo: {title: X, version: "1"}\ncomponents:\n  schemas:\n    X: {$ref: "../models.yaml#/X"}',
      "api/root.yaml",
      [{ path: "models.yaml", content: 'X: {$ref: "api/root.yaml#/components/schemas/X"}' }],
    );
    expect(result.valid).toBe(true);
    expect(result.references).toHaveLength(2);
  });
  it("rejects duplicate YAML keys, aliases and malformed JSON, with bounded locations", () => {
    for (const text of ["info: {title: A, title: B}", "a: &a [1]\nb: *a", '{"openapi": "3.0.3",}']) {
      const result = analyze("openapi", text, text.startsWith("{") ? "api.json" : "api.yaml");
      expect(result.valid).toBe(false);
      expect(result.diagnostics.length).toBeGreaterThan(0);
      expect(result.diagnostics.every((d) => d.line > 0 && d.column > 0)).toBe(true);
    }
  });
  it("validates both AsyncAPI 2 and 3 operation layouts", () => {
    const result = analyze(
      "asyncapi",
      'asyncapi: 2.6.0\ninfo: {title: Events, version: "1"}\nchannels:\n  pets:\n    publish:\n      operationId: sendPet',
    );
    expect(result.valid).toBe(true);
    expect(result.symbols.some((s) => s.name === "publish pets")).toBe(true);
    const invalid = analyze(
      "asyncapi",
      fixture("asyncapi.yaml").replace("action: receive", "action: unknown"),
    );
    expect(invalid.diagnostics.some((d) => d.message.includes("send or receive"))).toBe(true);
  });
  it("combines GraphQL SDL files, validates references and reports syntax locations", () => {
    const result = analyze("graphql", "type Query { pet: Pet }", "root.graphql", [
      { path: "pet.graphql", content: '"Pet documentation"\ntype Pet { name: String! }' },
    ]);
    expect(result.valid).toBe(true);
    expect(result.references.some((r) => r.target === "Pet" && r.resolved)).toBe(true);
    expect(result.symbols.find((s) => s.name === "Pet")).toMatchObject({
      file: "pet.graphql",
      line: 1,
      description: "Pet documentation",
    });
    expect(analyze("graphql", "type Query { pet: Missing }").valid).toBe(false);
    expect(analyze("graphql", "type Query {\n pet: }").diagnostics[0]).toMatchObject({ line: 2 });
  });
  it("resolves protobuf imports from supplied sources and reports missing types/imports", () => {
    const root = 'syntax="proto3"; import "pet.proto"; service Pets { rpc Get (Pet) returns (Pet); }';
    expect(
      analyze("protobuf", root, "root.proto", [
        { path: "pet.proto", content: 'syntax="proto3"; message Pet { string name=1; }' },
      ]).valid,
    ).toBe(true);
    expect(analyze("protobuf", root, "root.proto").diagnostics.some((d) => d.code === "reference")).toBe(
      true,
    );
    const invalid = analyze("protobuf", 'syntax="proto3";\nmessage Pet { broken name = ; }', "bad.proto");
    expect(invalid.valid).toBe(false);
    expect(invalid.diagnostics[0].line).toBe(2);
  });
  it("accepts Smithy JSON AST, resolves shapes and catches unresolved references", () => {
    const text = JSON.stringify({
      smithy: "2.0",
      shapes: {
        "pets#Pet": { type: "structure", members: { name: { target: "smithy.api#String" } } },
        "pets#Get": { type: "operation", output: { target: "pets#Pet" } },
      },
    });
    const result = analyze("smithy", text, "model.json");
    expect(result.valid).toBe(true);
    expect(result.references).toHaveLength(2);
    expect(analyze("smithy", text.replace('pets#Pet"}', 'pets#Missing"}'), "model.json").valid).toBe(false);
  });
  it("diagnoses Smithy lexical, syntax and missing targets with source locations", () => {
    const result = analyze(
      "smithy",
      '$version: "2"\nnamespace pets\nstructure Pet { name: Missing }',
      "model.smithy",
    );
    expect(result.valid).toBe(false);
    expect(result.diagnostics[0]).toMatchObject({ file: "model.smithy", line: 3, code: "reference" });
    expect(analyze("smithy", '$version: "2"\nnamespace pets\nstructure Pet { name String }').valid).toBe(
      false,
    );
    expect(analyze("smithy", '$version: "2"\nnamespace pets\n?').diagnostics[0].line).toBe(3);
  });
  it("enforces paths, file counts, byte limits, missing entrypoint and depth", () => {
    expect(
      specificationSource.safeParse({
        format: "graphql",
        entrypoint: "../x",
        files: [{ path: "../x", content: "" }],
      }).success,
    ).toBe(false);
    expect(() => analyze("graphql", "x".repeat(SPEC_LIMITS.bytes + 1))).toThrow();
    expect(analyze("graphql", "💥".repeat(400000)).diagnostics[0].code).toBe("limit");
    expect(analyze("openapi", "[".repeat(61) + "]".repeat(61)).diagnostics[0].code).toBe("limit");
    expect(
      analyzeSpecification({ format: "graphql", entrypoint: "missing", files: [{ path: "x", content: "" }] })
        .diagnostics[0].code,
    ).toBe("file");
  });
});

describe("Smithy multi-file and inline definitions", () => {
  it("resolves IDL shape names across supplied files", () => {
    const result = analyze(
      "smithy",
      '$version: "2"\nnamespace pets\nstructure Request { pet: Pet }',
      "request.smithy",
      [{ path: "pet.smithy", content: '$version: "2"\nnamespace pets\nstructure Pet { name: String }' }],
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.references.some((r) => r.target === "pets#Pet" && r.resolved)).toBe(true);
  });
  it("reads inline operation inputs and JSON AST list/map targets", () => {
    const inline = analyze(
      "smithy",
      '$version: "2"\nnamespace pets\noperation Get { input := { name: String }, output := { status: String } }',
      "model.smithy",
    );
    expect(inline.diagnostics).toEqual([]);
    expect(inline.symbols.some((s) => s.name === "pets#GetInput")).toBe(true);
    const json = analyze(
      "smithy",
      JSON.stringify({
        smithy: "2.0",
        shapes: {
          "pets#Names": { type: "list", member: { target: "smithy.api#String" } },
          "pets#Labels": {
            type: "map",
            key: { target: "smithy.api#String" },
            value: { target: "pets#Names" },
          },
        },
      }),
      "model.json",
    );
    expect(json.diagnostics).toEqual([]);
    expect(json.references).toHaveLength(3);
  });
});
