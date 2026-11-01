import { describe, expect, it } from "vitest";
import { VISUALIZER_LIMITS, visualizationSchema } from "@/core/visualizer/model";

const valid = { template: "ok" };

describe("visualizationSchema", () => {
  it("accepts a minimal valid input", () => {
    expect(visualizationSchema.safeParse(valid).success).toBe(true);
  });
  it("rejects a missing template", () => {
    const { template: _template, ...rest } = valid;
    expect(visualizationSchema.safeParse(rest).success).toBe(false);
  });
  it("accepts template at the length limit and rejects one past it", () => {
    expect(
      visualizationSchema.safeParse({ ...valid, template: "a".repeat(VISUALIZER_LIMITS.template) }).success,
    ).toBe(true);
    expect(
      visualizationSchema.safeParse({ ...valid, template: "a".repeat(VISUALIZER_LIMITS.template + 1) })
        .success,
    ).toBe(false);
  });
  it("rejects a template that passes string-length max but exceeds byte limit", () => {
    expect(
      visualizationSchema.safeParse({ ...valid, template: "é".repeat(VISUALIZER_LIMITS.template / 2) })
        .success,
    ).toBe(true);
    expect(
      visualizationSchema.safeParse({ ...valid, template: "é".repeat(VISUALIZER_LIMITS.template / 2 + 1) })
        .success,
    ).toBe(false);
  });
  it("rejects oversized data but accepts small data", () => {
    expect(
      visualizationSchema.safeParse({ ...valid, data: { s: "a".repeat(VISUALIZER_LIMITS.data) } }).success,
    ).toBe(false);
    expect(visualizationSchema.safeParse({ ...valid, data: { s: "small" } }).success).toBe(true);
  });
  it("accepts valid options and rejects invalid option types", () => {
    expect(
      visualizationSchema.safeParse({ ...valid, options: { noEscape: true, strict: false } }).success,
    ).toBe(true);
    expect(visualizationSchema.safeParse({ ...valid, options: { noEscape: "yes" } }).success).toBe(false);
  });
});
