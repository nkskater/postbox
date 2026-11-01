import { describe, expect, it } from "vitest";
import { contractSchema, jsonSchema } from "@/core/contracts/model";

const validContract = {
  pathTemplate: "/pets/{id}",
  parameters: [
    { in: "query", name: "q", required: true, description: "", schema: {} },
    { in: "header", name: "X-Test", required: false, description: "", schema: {} },
    { in: "path", name: "id", required: true, description: "", schema: {} },
  ],
  requestBody: {},
  responseBody: {},
  responseStatus: [200],
};

describe("jsonSchema", () => {
  it("accepts a minimal valid input", () => {
    expect(jsonSchema.safeParse({}).success).toBe(true);
  });
});

describe("contractSchema", () => {
  it("accepts a minimal valid input", () => {
    expect(contractSchema.safeParse(validContract).success).toBe(true);
  });

  // Replaced the 4 'rejects missing...' tests with this single test as requested
  it("accepts an empty object", () => {
    expect(contractSchema.safeParse({}).success).toBe(true);
  });

  it("accepts pathTemplate at the length limit and rejects one past it", () => {
    expect(contractSchema.safeParse({ ...validContract, pathTemplate: "a".repeat(2000) }).success).toBe(true);
    expect(contractSchema.safeParse({ ...validContract, pathTemplate: "a".repeat(2001) }).success).toBe(
      false,
    );
  });

  // Updated array-limit test to build unique entries as requested
  it("accepts parameters at the array limit and rejects one past it", () => {
    const params100 = Array.from({ length: 100 }, (_, i) => ({ in: "query", name: `p${i}`, schema: true }));
    expect(contractSchema.safeParse({ ...validContract, parameters: params100 }).success).toBe(true);

    const params101 = Array.from({ length: 101 }, (_, i) => ({ in: "query", name: `p${i}`, schema: true }));
    expect(contractSchema.safeParse({ ...validContract, parameters: params101 }).success).toBe(false);
  });

  it("accepts parameter name at the length limit and rejects one past it", () => {
    const params = [{ ...validContract.parameters[0], name: "a".repeat(200) }];
    expect(contractSchema.safeParse({ ...validContract, parameters: params }).success).toBe(true);
    const overParams = [{ ...validContract.parameters[0], name: "a".repeat(201) }];
    expect(contractSchema.safeParse({ ...validContract, parameters: overParams }).success).toBe(false);
  });

  it("accepts parameter description at the length limit and rejects one past it", () => {
    const params = [{ ...validContract.parameters[0], description: "a".repeat(2000) }];
    expect(contractSchema.safeParse({ ...validContract, parameters: params }).success).toBe(true);
    const overParams = [{ ...validContract.parameters[0], description: "a".repeat(2001) }];
    expect(contractSchema.safeParse({ ...validContract, parameters: overParams }).success).toBe(false);
  });

  it("accepts responseStatus at the array limit and rejects one past it", () => {
    expect(contractSchema.safeParse({ ...validContract, responseStatus: Array(100).fill(200) }).success).toBe(
      true,
    );
    expect(contractSchema.safeParse({ ...validContract, responseStatus: Array(101).fill(200) }).success).toBe(
      false,
    );
  });

  it("accepts responseStatus at the lower boundary and rejects one below it", () => {
    expect(contractSchema.safeParse({ ...validContract, responseStatus: [100] }).success).toBe(true);
    expect(contractSchema.safeParse({ ...validContract, responseStatus: [99] }).success).toBe(false);
  });

  it("accepts responseStatus at the upper boundary and rejects one above it", () => {
    expect(contractSchema.safeParse({ ...validContract, responseStatus: [599] }).success).toBe(true);
    expect(contractSchema.safeParse({ ...validContract, responseStatus: [600] }).success).toBe(false);
  });

  it("rejects a non-integer responseStatus", () => {
    expect(contractSchema.safeParse({ ...validContract, responseStatus: [200.5] }).success).toBe(false);
  });

  // Added superRefine tests as requested

  // (a) path parameter without pathTemplate fails, with pathTemplate passes
  it("path parameters require pathTemplate", () => {
    const noTemplate = { ...validContract, pathTemplate: undefined };
    delete noTemplate.pathTemplate;
    expect(contractSchema.safeParse(noTemplate).success).toBe(false);

    const withTemplate = { ...validContract, pathTemplate: "/pets/{id}" };
    expect(contractSchema.safeParse(withTemplate).success).toBe(true);
  });

  // (b) case-insensitive duplicate header params fail, distinct query params pass
  it("rejects case-insensitive duplicate header parameters", () => {
    const dupHeaders = [
      { in: "header", name: "X-Key", required: true, description: "", schema: {} },
      { in: "header", name: "x-key", required: true, description: "", schema: {} },
    ];
    expect(contractSchema.safeParse({ ...validContract, parameters: dupHeaders }).success).toBe(false);

    const distinctQuery = [
      { in: "query", name: "a", required: true, description: "", schema: {} },
      { in: "query", name: "A", required: true, description: "", schema: {} },
    ];
    expect(contractSchema.safeParse({ ...validContract, parameters: distinctQuery }).success).toBe(true);
  });

  // (c) requestBody over 64 KiB fails
  it("rejects contract exceeding 64 KiB", () => {
    const largeBody = { blob: "a".repeat(70000) };
    expect(contractSchema.safeParse({ ...validContract, requestBody: largeBody }).success).toBe(false);
  });
});
