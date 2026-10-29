import { describe, expect, it } from "vitest";
import {
  emptyScopes,
  extractVariableNames,
  lookupVariable,
  redactSecrets,
  resolveTemplate,
  Resolver,
  variablesToRecord,
} from "@/core/variables/resolver";

describe("variable resolver", () => {
  it("substitutes simple variables", () => {
    const scopes = { ...emptyScopes(), environment: { host: "api.test", id: "42" } };
    expect(resolveTemplate("https://{{host}}/items/{{ id }}", scopes)).toEqual({
      value: "https://api.test/items/42",
      unresolved: [],
    });
  });

  it("applies Postman precedence: local > data > environment > collection > global", () => {
    const scopes = {
      globals: { v: "global", g: "g" },
      collection: { v: "collection", c: "c" },
      environment: { v: "environment", e: "e" },
      data: { v: "data", d: "d" },
      local: { v: "local" },
    };
    expect(resolveTemplate("{{v}}", scopes).value).toBe("local");
    delete (scopes.local as Record<string, string>).v;
    expect(resolveTemplate("{{v}}", scopes).value).toBe("data");
    delete (scopes.data as Record<string, string>).v;
    expect(resolveTemplate("{{v}}", scopes).value).toBe("environment");
    delete (scopes.environment as Record<string, string>).v;
    expect(lookupVariable(scopes, "v")).toEqual({ value: "collection", scope: "collection" });
    delete (scopes.collection as Record<string, string>).v;
    expect(resolveTemplate("{{v}}{{g}}{{c}}{{e}}{{d}}", scopes).value).toBe("globalgced");
  });

  it("reports unresolved variables and leaves them intact", () => {
    const r = resolveTemplate("{{a}}-{{missing}}-{{missing}}", { ...emptyScopes(), globals: { a: "1" } });
    expect(r.value).toBe("1-{{missing}}-{{missing}}");
    expect(r.unresolved).toEqual(["missing"]);
  });

  it("resolves nested variables", () => {
    const scopes = {
      ...emptyScopes(),
      environment: { base: "https://{{host}}:{{port}}", host: "h", port: "8080" },
    };
    expect(resolveTemplate("{{base}}/x", scopes).value).toBe("https://h:8080/x");
  });

  it("stops on circular references", () => {
    const scopes = { ...emptyScopes(), environment: { a: "{{b}}", b: "{{a}}" } };
    const r = resolveTemplate("{{a}}", scopes);
    expect(r.value).toMatch(/\{\{[ab]\}\}/);
  });

  it("generates dynamic variables", () => {
    const s = emptyScopes();
    expect(resolveTemplate("{{$guid}}", s).value).toMatch(/^[0-9a-f-]{36}$/);
    expect(Number(resolveTemplate("{{$timestamp}}", s).value)).toBeGreaterThan(1_600_000_000);
    const n = Number(resolveTemplate("{{$randomInt}}", s).value);
    expect(n).toBeGreaterThanOrEqual(0);
    expect(n).toBeLessThanOrEqual(1000);
    expect(resolveTemplate("{{$guid}}", s).value).not.toBe(resolveTemplate("{{$guid}}", s).value);
    expect(resolveTemplate("{{$isoTimestamp}}", s).value).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(resolveTemplate("{{$notAThing}}", s).unresolved).toEqual(["$notAThing"]);
  });

  it("user-defined variables override dynamic names", () => {
    expect(resolveTemplate("{{$guid}}", { ...emptyScopes(), local: { $guid: "fixed" } }).value).toBe("fixed");
  });

  it("ignores disabled variables when building records", () => {
    expect(
      variablesToRecord([
        { key: "a", value: "1", enabled: true, type: "default" },
        { key: "b", value: "2", enabled: false, type: "default" },
        { key: "", value: "3", enabled: true, type: "default" },
      ]),
    ).toEqual({ a: "1" });
  });

  it("collects unresolved names across calls", () => {
    const r = new Resolver(emptyScopes());
    r.resolve("{{x}}");
    r.resolve("{{y}} {{x}}");
    expect([...r.unresolved].sort()).toEqual(["x", "y"]);
  });

  it("extracts variable names and redacts secrets", () => {
    expect(extractVariableNames("{{a}}/{{ b }}")).toEqual(["a", "b"]);
    expect(redactSecrets("token=supersecret&x=1", ["supersecret", "x"])).toBe("token=********&x=1");
  });
});
