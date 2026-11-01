import { describe, expect, it } from "vitest";
import {
  KINDS,
  buildScenario,
  describeScenario,
  emptyForm,
  withKind,
  type ScenarioForm,
} from "@/lib/mock-scenario-form";

const form = (patch: Partial<ScenarioForm>): ScenarioForm => ({ ...emptyForm(), ...patch });

describe("scenario form", () => {
  it("builds every kind of scenario from the default form values", () => {
    for (const { kind } of KINDS) {
      const s = buildScenario(form({ kind }), "id1");
      expect(s.kind).toBe(kind);
      expect(s.id).toBe("id1");
      expect(s.enabled).toBe(true);
      expect(s.name.length).toBeGreaterThan(0);
    }
  });

  it("carries the options through", () => {
    expect(
      buildScenario(
        form({
          kind: "failFirst",
          name: " Warm up ",
          count: "3",
          status: "502",
          method: "post",
          path: "/users/:id",
          body: "nope",
        }),
        "a",
      ),
    ).toMatchObject({
      kind: "failFirst",
      name: "Warm up",
      count: 3,
      status: 502,
      body: "nope",
      match: { method: "post", path: "/users/:id" },
    });
    expect(
      buildScenario(form({ kind: "sequence", statuses: "500 , 0,429", repeat: false }), "a"),
    ).toMatchObject({
      statuses: [500, 0, 429],
      repeat: false,
    });
    expect(
      buildScenario(form({ kind: "rateLimit", limit: "10", windowSeconds: "30", status: "" }), "a"),
    ).toMatchObject({
      limit: 10,
      windowSeconds: 30,
      status: 429,
    });
  });

  it("explains what is wrong with a field", () => {
    expect(() => buildScenario(form({ kind: "error", status: "200" }), "a")).toThrow(/status/);
    expect(() => buildScenario(form({ kind: "error", status: "" }), "a")).toThrow(/status/);
    expect(() => buildScenario(form({ kind: "failEvery", every: "1" }), "a")).toThrow(/every/);
    expect(() => buildScenario(form({ kind: "delay", ms: "99999" }), "a")).toThrow(/ms/);
    expect(() => buildScenario(form({ kind: "sequence", statuses: "abc" }), "a")).toThrow();
    expect(() => buildScenario(form({ kind: "error", path: "users" }), "a")).toThrow(/path/);
  });

  it("moves the default status with the type, but keeps one the user chose", () => {
    expect(withKind(emptyForm(), "rateLimit").status).toBe("429");
    expect(withKind(withKind(emptyForm(), "rateLimit"), "error").status).toBe("503");
    expect(withKind(form({ status: "418" }), "rateLimit").status).toBe("418");
    expect(withKind(emptyForm(), "sequence").kind).toBe("sequence");
  });

  it("describes scenarios in plain words", () => {
    const d = (patch: Partial<ScenarioForm>) => describeScenario(buildScenario(form(patch), "a"));
    expect(d({ kind: "failFirst", count: "1", status: "503" })).toBe("Answers 503 to the first 1 request");
    expect(d({ kind: "failFirst", count: "2", status: "503", method: "get", path: "/x" })).toBe(
      "Answers 503 to the first 2 requests on GET /x",
    );
    expect(d({ kind: "failEvery", every: "4", status: "500" })).toBe("Answers 500 to every 4th request");
    expect(d({ kind: "error", status: "500" })).toBe("Always answers 500");
    expect(d({ kind: "delay", ms: "250" })).toBe("Adds 250 ms of latency");
    expect(d({ kind: "sequence", statuses: "500,0" })).toBe("Answers 500, example, then repeats");
    expect(
      describeScenario(
        buildScenario({ ...withKind(emptyForm(), "rateLimit"), limit: "5", windowSeconds: "60" }, "a"),
      ),
    ).toBe("Allows 5 requests per 60 s, then 429");
  });
});
