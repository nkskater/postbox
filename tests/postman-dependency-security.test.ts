import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
const require = createRequire(import.meta.url);
const sdkRequire = createRequire(require.resolve("postman-collection"));
const sdk = sdkRequire("postman-collection");
const dynamic = sdkRequire("postman-collection/lib/superstring/dynamic-variables.js") as Record<
  string,
  { generator: () => unknown }
>;
const legacy = sdkRequire("@faker-js/faker/locale/en");

describe("patched Postman dependency compatibility", () => {
  it("uses the named adapter only for the SDK and patched Faker for normal application imports", () => {
    expect(sdkRequire("@faker-js/faker/package.json").name).toBe("@postbox/postman-faker-compat");
    expect(require("@faker-js/faker/package.json").version).toBe("10.6.0");
    expect(require("@faker-js/faker").faker.location.city()).toBeTypeOf("string");
    expect(createRequire(require.resolve("postman-code-generators"))("postman-collection")).toBe(sdk);
    expect(legacy.fake).toBeUndefined();
    expect(legacy.helpers).toBeUndefined();
    expect(Object.isFrozen(legacy)).toBe(true);
  });
  it.each(Object.entries(dynamic))("generates the real SDK dynamic value %s", (_name, item) => {
    const value = item.generator();
    expect(value).not.toBeNull();
    expect(value).not.toBeUndefined();
    expect(String(value).length).toBeGreaterThan(0);
    expect(
      typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean" ||
        value instanceof Date,
    ).toBe(true);
    if (typeof value === "number") expect(Number.isFinite(value)).toBe(true);
    if (value instanceof Date) expect(Number.isFinite(value.getTime())).toBe(true);
  });
  it("preserves SDK interpolation with modern random generators", () => {
    const scope = new sdk.VariableScope({ values: [{ key: "literal", value: "kept" }] });
    expect(scope.replaceIn("{{literal}}/{{$randomUUID}}/{{$randomCity}}")).toMatch(
      /^kept\/[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\/.+$/i,
    );
  });
  it("retains complete SDK collection/request import-export round trips", () => {
    const collection = new sdk.Collection({
      info: { name: "Dependency contract" },
      variable: [{ key: "token", value: "literal" }],
      item: [
        {
          name: "Request",
          request: {
            method: "POST",
            url: "https://example.test/v1?q=one&q=two",
            header: [{ key: "X-Test", value: "{{token}}" }],
            auth: { type: "bearer", bearer: [{ key: "token", value: "{{token}}" }] },
            body: { mode: "raw", raw: '{"preserved":"日本語"}' },
          },
        },
      ],
    });
    const exported = collection.toJSON();
    // The SDK adds private import metadata; every original public field must round-trip.
    expect(new sdk.Collection(exported).toJSON()).toMatchObject(exported);
    expect(exported.item[0].request.body.raw).toBe('{"preserved":"日本語"}');
    expect(exported.item[0].request.auth.bearer[0].value).toBe("{{token}}");
  });
  it("uses UUID's patched buffer checks while preserving SDK v4 identifiers", () => {
    expect(sdkRequire("uuid/package.json").version).toBe("11.1.1");
    const uuid = sdkRequire("uuid"),
      namespace = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
    expect(() => uuid.v5("input", namespace, new Uint8Array(8), 4)).toThrow(RangeError);
    expect(new sdk.Collection({ info: { name: "Identifier contract" } }).id).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i,
    );
  });
});
