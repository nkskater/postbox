import { describe, expect, it } from "vitest";
import { buildSnapshot } from "@/core/dependencies/model";
import {
  latestReviews,
  mergeReadiness,
  openMergeRequestInput,
  protectedChanges,
  standingReviews,
  type ReviewRecord,
} from "@/core/review/model";
import type { FolderNode, RequestNode } from "@/core/types";
import { newDraft } from "@/stores/app";

const request = (id: string, name: string, extra: Partial<RequestNode> = {}): RequestNode => {
  const { folderId: _f, ...def } = newDraft({ name });
  return { ...def, ...extra, id, name, kind: "request" } as RequestNode;
};
const collection = (children: FolderNode["children"]): FolderNode => ({
  id: "root",
  name: "API",
  kind: "folder",
  description: "",
  auth: { type: "none" } as FolderNode["auth"],
  headers: [],
  preRequestScript: "",
  testScript: "",
  children,
});
const snap = (children: FolderNode["children"]) => buildSnapshot(collection(children), []);

describe("protected changes", () => {
  it("flags script and example edits, new requests with scripts, and removed ones", () => {
    const base = snap([
      request("a", "A"),
      request("b", "B", { testScript: "pm.test('x')" }),
      request("c", "C"),
    ]);
    const head = snap([
      request("a", "A", { preRequestScript: "console.log(1)" }),
      request("b", "B", { testScript: "pm.test('x')" }),
      request("d", "D", { testScript: "pm.test('new')" }),
    ]);
    const found = protectedChanges(base, head).map((c) => [c.path, c.kind, c.fields.join(",")]);
    expect(found).toEqual([
      ["A", "changed", "preRequestScript"],
      ["D", "added", "testScript"],
    ]);
  });

  it("ignores harmless edits and requests without scripts", () => {
    const base = snap([request("a", "A")]);
    const head = snap([request("a", "Renamed"), request("b", "B")]);
    expect(protectedChanges(base, head)).toEqual([]);
  });

  it("flags a removed request that had a script", () => {
    const base = snap([request("a", "A", { testScript: "x" })]);
    expect(protectedChanges(base, snap([])).map((c) => c.path)).toEqual(["A"]);
  });
});

const review = (who: string, decision: "approve" | "reject", head: string, at: number): ReviewRecord => ({
  reviewerId: who,
  reviewerName: who,
  decision,
  headChecksum: head,
  createdAt: at,
});

describe("reviews", () => {
  it("keeps only each reviewer's latest word", () => {
    const all = [
      review("ann", "reject", "h1", 1),
      review("ann", "approve", "h1", 2),
      review("bo", "approve", "h1", 3),
    ];
    expect(latestReviews(all).map((r) => `${r.reviewerId}:${r.decision}`)).toEqual([
      "ann:approve",
      "bo:approve",
    ]);
  });

  it("makes approvals stale when the content changed, and ignores the author's own", () => {
    const all = [
      review("ann", "approve", "old", 1),
      review("bo", "approve", "new", 2),
      review("author", "approve", "new", 3),
    ];
    const standing = standingReviews(all, "new", "author");
    expect(standing.approvals.map((r) => r.reviewerId)).toEqual(["bo"]);
    expect(standing.stale.map((r) => r.reviewerId)).toEqual(["ann"]);
    expect(standingReviews([review("ann", "reject", "new", 1)], "new", "author").rejections).toHaveLength(1);
    // A rejection of earlier content no longer blocks.
    expect(standingReviews([review("ann", "reject", "old", 1)], "new", "author").rejections).toHaveLength(0);
  });
});

describe("merge readiness", () => {
  const ready = {
    conflicts: 0,
    approvals: 1,
    rejections: 0,
    protectedCount: 0,
    mergerIsOwner: false,
    hasChanges: true,
  };
  it("allows an approved, conflict-free request", () => {
    expect(mergeReadiness(ready)).toEqual({ ok: true, reasons: [] });
  });
  it("needs approval unless the merger is an owner", () => {
    expect(mergeReadiness({ ...ready, approvals: 0 }).reasons).toEqual([
      "It needs approval from someone other than its author",
    ]);
    expect(mergeReadiness({ ...ready, approvals: 0, mergerIsOwner: true }).ok).toBe(true);
  });
  it("blocks on conflicts, rejections and nothing to merge, even for owners", () => {
    const owner = { ...ready, mergerIsOwner: true };
    expect(mergeReadiness({ ...owner, conflicts: 2 }).ok).toBe(false);
    expect(mergeReadiness({ ...owner, rejections: 1 }).ok).toBe(false);
    expect(mergeReadiness({ ...owner, hasChanges: false }).ok).toBe(false);
  });
  it("reserves script and example changes for owners", () => {
    expect(mergeReadiness({ ...ready, protectedCount: 1 }).reasons[0]).toContain("only a workspace owner");
    expect(mergeReadiness({ ...ready, protectedCount: 1, mergerIsOwner: true }).ok).toBe(true);
  });
  it("validates merge request input", () => {
    expect(openMergeRequestInput.safeParse({ title: "  " }).success).toBe(false);
    expect(openMergeRequestInput.parse({ title: " Add paging " })).toEqual({
      title: "Add paging",
      description: "",
    });
  });
});
