import { describe, expect, it } from "vitest";
import type { GovernanceDiagnostic } from "@/core/governance/model";
import { governanceVerdict, newDiagnostics } from "@/core/review/governance";
import { mergeReadiness } from "@/core/review/model";

const d = (
  ruleId: string,
  severity: GovernanceDiagnostic["severity"],
  path: string,
  line = 1,
  file = "api.yaml",
): GovernanceDiagnostic =>
  ({ ruleId, severity, path, message: `${ruleId} failed`, file, line, column: 1 }) as GovernanceDiagnostic;

describe("governance comparison", () => {
  it("counts only findings the merge adds, ignoring line numbers", () => {
    const before = [d("op-id", "error", "/paths/a/get", 10), d("summary", "warning", "/paths/a/get", 11)];
    const after = [
      d("op-id", "error", "/paths/a/get", 40),
      d("summary", "warning", "/paths/a/get", 41),
      d("op-id", "error", "/paths/b/get", 50),
    ];
    expect(newDiagnostics(before, after).map((x) => x.path)).toEqual(["/paths/b/get"]);
  });

  it("counts repeats, so a second identical finding is new", () => {
    const one = [d("r", "error", "/x")];
    expect(newDiagnostics(one, [...one, ...one])).toHaveLength(1);
    expect(newDiagnostics([...one, ...one], one)).toHaveLength(0);
  });

  it("splits new findings by severity and counts what was fixed", () => {
    const before = [d("old", "error", "/old"), d("keep", "warning", "/keep")];
    const after = [
      d("keep", "warning", "/keep"),
      d("e", "error", "/e"),
      d("w", "warning", "/w"),
      d("i", "info", "/i"),
    ];
    const v = governanceVerdict(before, after);
    expect(v.newErrors.map((x) => x.ruleId)).toEqual(["e"]);
    expect(v.newWarnings.map((x) => x.ruleId)).toEqual(["w"]);
    expect(v).toMatchObject({ newInfo: 1, fixed: 1 });
  });

  it("makes new governance errors block a merge, for owners too", () => {
    const base = {
      conflicts: 0,
      approvals: 1,
      rejections: 0,
      protectedCount: 0,
      mergerIsOwner: false,
      hasChanges: true,
    };
    expect(mergeReadiness({ ...base, governanceErrors: 0 }).ok).toBe(true);
    const blocked = mergeReadiness({ ...base, governanceErrors: 2 });
    expect(blocked.ok).toBe(false);
    expect(blocked.reasons[0]).toContain("2 new governance error(s)");
    expect(mergeReadiness({ ...base, mergerIsOwner: true, governanceErrors: 1 }).ok).toBe(false);
  });
});
