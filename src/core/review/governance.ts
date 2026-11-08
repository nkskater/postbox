/**
 * Which governance findings a merge would add. Only findings the original does not already have count:
 * an old problem is not the merge's fault, and blocking on it would make a large spec unmergeable until
 * someone fixes everything. Findings are matched by rule, file, location path and message, never by line
 * number, which shifts whenever text above moves.
 */
import type { GovernanceDiagnostic } from "../governance/model";

const keyOf = (d: GovernanceDiagnostic) => `${d.ruleId}\u0000${d.file}\u0000${d.path}\u0000${d.message}`;

/** The diagnostics in `after` beyond those already in `before` (counting repeats). */
export function newDiagnostics(
  before: GovernanceDiagnostic[],
  after: GovernanceDiagnostic[],
): GovernanceDiagnostic[] {
  const remaining = new Map<string, number>();
  for (const d of before) remaining.set(keyOf(d), (remaining.get(keyOf(d)) ?? 0) + 1);
  const added: GovernanceDiagnostic[] = [];
  for (const d of after) {
    const left = remaining.get(keyOf(d)) ?? 0;
    if (left > 0) remaining.set(keyOf(d), left - 1);
    else added.push(d);
  }
  return added;
}

export interface GovernanceVerdict {
  newErrors: GovernanceDiagnostic[];
  newWarnings: GovernanceDiagnostic[];
  newInfo: number;
  /** Findings the merge removes, as a number; shown as good news. */
  fixed: number;
}

export function governanceVerdict(
  before: GovernanceDiagnostic[],
  after: GovernanceDiagnostic[],
): GovernanceVerdict {
  const added = newDiagnostics(before, after);
  return {
    newErrors: added.filter((d) => d.severity === "error"),
    newWarnings: added.filter((d) => d.severity === "warning"),
    newInfo: added.filter((d) => d.severity === "info").length,
    fixed: newDiagnostics(after, before).length,
  };
}
