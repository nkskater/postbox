/**
 * Rules for reviewing a fork's changes before they reach the collection they came from. Pure functions:
 * the server supplies snapshots and reviews, this decides what needs a closer look and whether a merge is
 * allowed.
 */
import { z } from "zod";
import { flatten, type Snapshot } from "../dependencies/model";

/** Node fields whose change needs an owner: code that runs, and saved responses that mocks and docs serve. */
export const PROTECTED_FIELDS = ["preRequestScript", "testScript", "examples"] as const;

export const MERGE_REQUEST_LIMITS = { title: 200, description: 4000, note: 2000 } as const;
export const REVIEW_DECISIONS = ["approve", "reject"] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];
export type MergeRequestStatus = "open" | "merged" | "closed";

export const openMergeRequestInput = z.object({
  title: z.string().trim().min(1, "A title is required").max(MERGE_REQUEST_LIMITS.title),
  description: z.string().max(MERGE_REQUEST_LIMITS.description).default(""),
});
export const reviewInput = z.object({
  decision: z.enum(REVIEW_DECISIONS),
  note: z.string().max(MERGE_REQUEST_LIMITS.note).default(""),
});
export const closeInput = z.object({ note: z.string().max(MERGE_REQUEST_LIMITS.note).default("") });

export interface ProtectedChange {
  path: string;
  kind: "added" | "changed";
  fields: string[];
}

const present = (value: unknown) =>
  Array.isArray(value) ? value.length > 0 : typeof value === "string" ? value.trim() !== "" : !!value;
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Changes from `base` to `head` that touch scripts or saved examples, including on new requests. */
export function protectedChanges(base: Snapshot, head: Snapshot): ProtectedChange[] {
  const before = flatten(base);
  const out: ProtectedChange[] = [];
  for (const node of flatten(head).values()) {
    const old = before.get(node.sid);
    const fields = PROTECTED_FIELDS.filter((f) =>
      old ? !same(old.data[f], node.data[f]) : present(node.data[f]),
    );
    if (fields.length) out.push({ path: node.path, kind: old ? "changed" : "added", fields: [...fields] });
  }
  for (const node of before.values()) {
    if (flatten(head).has(node.sid)) continue;
    const fields = PROTECTED_FIELDS.filter((f) => present(node.data[f]));
    if (fields.length) out.push({ path: node.path, kind: "changed", fields: [...fields] });
  }
  return out;
}

export interface ReviewRecord {
  reviewerId: string | null;
  reviewerName: string;
  decision: ReviewDecision;
  headChecksum: string;
  createdAt: number;
}

/** A person's latest review stands; earlier ones are history. Identity falls back to the name. */
export function latestReviews<T extends ReviewRecord>(reviews: T[]): T[] {
  const latest = new Map<string, T>();
  for (const review of [...reviews].sort((a, b) => a.createdAt - b.createdAt))
    latest.set(review.reviewerId ?? `name:${review.reviewerName}`, review);
  return [...latest.values()];
}

/**
 * Reviews only count for the exact content they were given on: once the fork changes, earlier approvals
 * and rejections go stale and the request needs a fresh look.
 */
export function standingReviews<T extends ReviewRecord>(
  reviews: T[],
  headChecksum: string,
  authorId: string | null,
) {
  const current = latestReviews(reviews).filter((r) => r.headChecksum === headChecksum);
  return {
    approvals: current.filter(
      (r) => r.decision === "approve" && (authorId === null || r.reviewerId !== authorId),
    ),
    rejections: current.filter((r) => r.decision === "reject"),
    stale: latestReviews(reviews).filter((r) => r.headChecksum !== headChecksum),
  };
}

export interface Readiness {
  ok: boolean;
  reasons: string[];
}

/** Whether a merge may go ahead, and if not, why, in words a reviewer can act on. */
export function mergeReadiness(input: {
  conflicts: number;
  approvals: number;
  rejections: number;
  protectedCount: number;
  /** The person merging holds the owner role in the target workspace. */
  mergerIsOwner: boolean;
  hasChanges: boolean;
}): Readiness {
  const reasons: string[] = [];
  if (!input.hasChanges) reasons.push("There is nothing to merge");
  if (input.conflicts > 0)
    reasons.push(
      `${input.conflicts} change(s) conflict with edits made since the fork; update the fork first`,
    );
  if (input.rejections > 0) reasons.push("A reviewer asked for changes");
  if (input.protectedCount > 0 && !input.mergerIsOwner)
    reasons.push("This changes scripts or saved examples, so only a workspace owner can merge it");
  if (input.approvals === 0 && !input.mergerIsOwner)
    reasons.push("It needs approval from someone other than its author");
  return { ok: reasons.length === 0, reasons };
}
