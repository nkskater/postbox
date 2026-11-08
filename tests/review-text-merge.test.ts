import { describe, expect, it } from "vitest";
import { mergeText } from "@/core/review/text-merge";

const t = (...lines: string[]) => lines.join("\n");

describe("mergeText", () => {
  const base = t("a", "b", "c", "d", "e", "f", "g", "h");

  it("combines edits to different parts of the text", () => {
    const ours = t("a", "B!", "c", "d", "e", "f", "g", "h");
    const theirs = t("a", "b", "c", "d", "e", "f", "G!", "h");
    expect(mergeText(base, ours, theirs)).toEqual({
      clean: true,
      text: t("a", "B!", "c", "d", "e", "f", "G!", "h"),
      conflicts: [],
    });
    // Order of the arguments does not matter for a clean merge.
    expect(mergeText(base, theirs, ours).text).toBe(t("a", "B!", "c", "d", "e", "f", "G!", "h"));
  });

  it("combines insertions and deletions in separate places", () => {
    const ours = t("start", "a", "b", "c", "d", "e", "f", "g", "h");
    const theirs = t("a", "b", "c", "e", "f", "g", "h", "end");
    const r = mergeText(base, ours, theirs);
    expect(r.clean).toBe(true);
    expect(r.text).toBe(t("start", "a", "b", "c", "e", "f", "g", "h", "end"));
  });

  it("takes the other side when only one changed, or when both made the same change", () => {
    expect(mergeText(base, base, "x").text).toBe("x");
    expect(mergeText(base, "x", base).text).toBe("x");
    const same = t("a", "b", "CHANGED", "d", "e", "f", "g", "h");
    expect(mergeText(base, same, same)).toEqual({ clean: true, text: same, conflicts: [] });
    const a = t("a", "b", "SAME", "d", "e", "f", "g", "h");
    const b = t("a", "b", "SAME", "d", "e", "f", "g", "H!");
    expect(mergeText(base, a, b).text).toBe(t("a", "b", "SAME", "d", "e", "f", "g", "H!"));
  });

  it("reports overlapping edits as a conflict and shows both versions", () => {
    const ours = t("a", "b", "mine", "d", "e", "f", "g", "h");
    const theirs = t("a", "b", "theirs", "d", "e", "f", "g", "h");
    const r = mergeText(base, ours, theirs);
    expect(r.clean).toBe(false);
    expect(r.conflicts).toEqual([{ line: 3, base: ["c"], ours: ["mine"], theirs: ["theirs"] }]);
    expect(r.text).toContain("<<<<<<< ours\nmine\n=======\ntheirs\n>>>>>>> theirs");
  });

  it("treats different insertions at the same place as a conflict, identical ones as agreement", () => {
    const x = t("a", "b", "NEW1", "c", "d", "e", "f", "g", "h");
    const y = t("a", "b", "NEW2", "c", "d", "e", "f", "g", "h");
    expect(mergeText(base, x, y).clean).toBe(false);
    expect(mergeText(base, x, x).clean).toBe(true);
  });

  it("flags a deletion that overlaps an edit", () => {
    const ours = t("a", "b", "d", "e", "f", "g", "h"); // deleted c
    const theirs = t("a", "b", "C!", "d", "e", "f", "g", "h"); // edited c
    const r = mergeText(base, ours, theirs);
    expect(r.clean).toBe(false);
    expect(r.conflicts[0]).toMatchObject({ line: 3, base: ["c"], ours: [], theirs: ["C!"] });
  });

  it("keeps clean regions around a conflict and reports each conflict", () => {
    const ours = t("a", "OURS-B", "c", "d", "e", "f", "OURS-G", "h", "extra-mine");
    const theirs = t("a", "THEIRS-B", "c", "d", "e", "f", "THEIRS-G", "h");
    const r = mergeText(base, ours, theirs);
    expect(r.conflicts.map((c) => c.line)).toEqual([2, 7]);
    expect(r.text.split("\n")).toContain("extra-mine");
  });

  it("merges realistic YAML edits to different keys", () => {
    const spec = [
      "openapi: 3.0.0",
      "info:",
      "  title: Pets",
      "  version: '1'",
      "paths:",
      "  /pets:",
      "    get:",
      "      summary: List",
      "  /owners:",
      "    get:",
      "      summary: Owners",
    ].join("\n");
    const ours = spec.replace("summary: List", "summary: List all pets");
    const theirs = spec.replace("summary: Owners", "summary: List owners\n      description: With paging");
    const r = mergeText(spec, ours, theirs);
    expect(r.clean).toBe(true);
    expect(r.text).toContain("summary: List all pets");
    expect(r.text).toContain("description: With paging");
  });

  it("handles empty text and very large tangled edits without hanging", () => {
    expect(mergeText("", "x", "x").text).toBe("x");
    expect(mergeText("", "x", "").text).toBe("x");
    const big = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\n");
    const ours = Array.from({ length: 3000 }, (_, i) => `ours ${i}`).join("\n");
    const theirs = Array.from({ length: 3000 }, (_, i) => `theirs ${i}`).join("\n");
    const r = mergeText(big, ours, theirs);
    expect(r.clean).toBe(false);
    expect(r.conflicts).toHaveLength(1);
  });
});
