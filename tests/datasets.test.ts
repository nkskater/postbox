import { describe, expect, it } from "vitest";
import {
  validateDataset,
  parseDatasetImport,
  maskDataset,
  suggestedSecretColumns,
} from "@/core/runner/datasets";
describe("saved dataset validation and interchange", () => {
  it("keeps column order/string values and pads missing cells without losing undeclared data", () => {
    expect(validateDataset({ columns: ["id", "name"], rows: [{ id: "1" }] })).toEqual({
      columns: ["id", "name"],
      rows: [{ id: "1", name: "" }],
    });
    for (const table of [
      { columns: ["id", "id"], rows: [] },
      { columns: [" id "], rows: [] },
      { columns: ["id"], rows: [{ id: "1", other: "lost" }] },
    ])
      expect(() => validateDataset(table, [])).toThrow();
  });
  it("preserves LAB-54 CSV failures and short-row diagnostics", () => {
    for (const content of ["id,id\n1,2", "id,name\n1,A,extra", "id,\n1,lost"])
      expect(() => parseDatasetImport({ content, format: "csv" })).toThrow(/Invalid iteration/);
    const parsed = parseDatasetImport({ content: "id,name\n1", format: "csv" });
    expect(parsed.warnings).toHaveLength(1);
    expect(parsed.table.rows[0]).toEqual({ id: "1", name: "" });
  });
  it("suggests named secret columns and masks only their cells", () => {
    expect(suggestedSecretColumns(["name", "api_key", "password"])).toEqual(["api_key", "password"]);
    const table = { columns: ["name", "password"], rows: [{ name: "Mochi 🐾", password: "secret" }] };
    expect(maskDataset(table, ["password"]).rows[0]).toEqual({ name: "Mochi 🐾", password: "[REDACTED]" });
    expect(table.rows[0].password).toBe("secret");
  });
  it("rejects wrong secret metadata, excessive cells/rows and content sizes", () => {
    const table = { columns: ["id"], rows: [{ id: "1" }] };
    for (const secretColumns of [["missing"], ["id", "id"]])
      expect(() => validateDataset(table, secretColumns)).toThrow(/Secret columns/);
    expect(() =>
      validateDataset(
        { columns: ["token"], rows: Array.from({ length: 10001 }, () => ({ token: "secret" })) },
        ["token"],
      ),
    ).toThrow(/secret cells/);
    expect(() =>
      validateDataset({ columns: ["id"], rows: [{ id: "x".repeat(21 * 1024 * 1024) }] }, []),
    ).toThrow(/20 MiB/);
  });
});
