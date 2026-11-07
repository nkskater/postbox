import { describe, expect, it } from "vitest";
import { diffFiles, mergeFiles, planFileMerge, type FileState } from "@/core/review/files";

const state = (entry: string, files: Record<string, string>): FileState => ({
  entrypoint: entry,
  files: Object.entries(files).map(([path, content]) => ({ path, content })),
});
const base = state("api.yaml", { "api.yaml": "v1", "schemas/pet.yaml": "pet1", "old.yaml": "old" });
const actions = (plan: ReturnType<typeof planFileMerge>) =>
  Object.fromEntries(plan.entries.map((e) => [e.path, e.action]));

describe("diffFiles", () => {
  it("lists added, removed and changed files and a moved entrypoint", () => {
    const next = state("main.yaml", {
      "main.yaml": "m",
      "api.yaml": "v2",
      "schemas/pet.yaml": "pet1",
      "new.yaml": "n",
    });
    const d = diffFiles(base, next);
    expect(d).toMatchObject({
      added: ["main.yaml", "new.yaml"],
      removed: ["old.yaml"],
      changed: ["api.yaml"],
      entrypoint: "main.yaml",
      identical: false,
    });
    expect(diffFiles(base, base).identical).toBe(true);
  });
});

describe("file merge", () => {
  it("takes what only one side changed", () => {
    const incoming = state("api.yaml", {
      "api.yaml": "v2",
      "schemas/pet.yaml": "pet1",
      "old.yaml": "old",
      "added.yaml": "a",
    });
    const local = state("api.yaml", { "api.yaml": "v1", "schemas/pet.yaml": "pet-mine", "old.yaml": "old" });
    const plan = planFileMerge(base, incoming, local);
    expect(actions(plan)).toMatchObject({
      "api.yaml": "update",
      "added.yaml": "add",
      "schemas/pet.yaml": "keep",
      "old.yaml": "keep",
    });
    expect(plan.conflicts).toBe(0);
    const merged = mergeFiles(base, incoming, local, "keep-local");
    expect(Object.fromEntries(merged.files.map((f) => [f.path, f.content]))).toEqual({
      "api.yaml": "v2",
      "schemas/pet.yaml": "pet-mine",
      "old.yaml": "old",
      "added.yaml": "a",
    });
  });

  it("removes what upstream removed unless it was changed here", () => {
    const incoming = state("api.yaml", { "api.yaml": "v1", "schemas/pet.yaml": "pet1" });
    expect(actions(planFileMerge(base, incoming, base))["old.yaml"]).toBe("remove");
    const edited = state("api.yaml", { "api.yaml": "v1", "schemas/pet.yaml": "pet1", "old.yaml": "edited" });
    const plan = planFileMerge(base, incoming, edited);
    expect(plan.entries.find((e) => e.path === "old.yaml")).toMatchObject({
      action: "conflict",
      reason: "removed upstream but changed here",
    });
    expect(mergeFiles(base, incoming, edited, "keep-local").files.map((f) => f.path)).toContain("old.yaml");
    expect(mergeFiles(base, incoming, edited, "take-incoming").files.map((f) => f.path)).not.toContain(
      "old.yaml",
    );
  });

  it("flags a file changed differently on both sides, but not identical edits", () => {
    const incoming = state("api.yaml", {
      "api.yaml": "theirs",
      "schemas/pet.yaml": "pet1",
      "old.yaml": "old",
    });
    const local = state("api.yaml", { "api.yaml": "mine", "schemas/pet.yaml": "pet1", "old.yaml": "old" });
    expect(planFileMerge(base, incoming, local).conflicts).toBe(1);
    expect(
      mergeFiles(base, incoming, local, "keep-local").files.find((f) => f.path === "api.yaml")?.content,
    ).toBe("mine");
    expect(
      mergeFiles(base, incoming, local, "take-incoming").files.find((f) => f.path === "api.yaml")?.content,
    ).toBe("theirs");
    expect(planFileMerge(base, incoming, incoming).conflicts).toBe(0);
  });

  it("treats the entrypoint like a file", () => {
    const incoming = state("main.yaml", {
      "main.yaml": "m",
      "api.yaml": "v1",
      "schemas/pet.yaml": "pet1",
      "old.yaml": "old",
    });
    expect(planFileMerge(base, incoming, base).entries.find((e) => e.path === "the entrypoint")?.action).toBe(
      "update",
    );
    expect(mergeFiles(base, incoming, base, "keep-local").entrypoint).toBe("main.yaml");
    const local = state("other.yaml", {
      "other.yaml": "o",
      "api.yaml": "v1",
      "schemas/pet.yaml": "pet1",
      "old.yaml": "old",
    });
    expect(
      planFileMerge(base, incoming, local).entries.find((e) => e.path === "the entrypoint")?.action,
    ).toBe("conflict");
  });
});
