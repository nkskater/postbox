/** Pure deterministic matching for saved mock request/response pairs. */
export interface MockCandidate {
  id: string;
  method: string;
  path: string;
  query: [string, string][];
  body: string;
  status: number;
  name: string;
}
export interface MockObservation {
  method: string;
  path: string;
  query: [string, string][];
  body: string;
}
export interface MatchOptions {
  matchQuery?: boolean;
  matchBody?: boolean;
  exampleId?: string;
  exampleName?: string;
  status?: number;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, value]) => [key, canonical(value)]),
    );
  return value;
}
export function canonicalBody(body: string): string {
  try {
    return JSON.stringify(canonical(JSON.parse(body)));
  } catch {
    return body;
  }
}
function queryKey(query: [string, string][]): string {
  return JSON.stringify(
    [...query].sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0)),
  );
}
function segments(path: string): string[] {
  return path.split("/").map((segment) => decodeURIComponent(segment));
}
/** Exact segments outrank whole-segment :parameters and {{variables}}. Ties retain saved order. */
export function matchMock<T extends MockCandidate>(
  candidates: readonly T[],
  observation: MockObservation,
  options: MatchOptions = {},
): T | null {
  const incoming = segments(observation.path);
  let best: T | null = null,
    bestScore = -1;
  for (const candidate of candidates) {
    if (candidate.method.toUpperCase() !== observation.method.toUpperCase()) continue;
    if (options.exampleId !== undefined && candidate.id !== options.exampleId) continue;
    if (options.exampleName !== undefined && candidate.name !== options.exampleName) continue;
    if (options.status !== undefined && candidate.status !== options.status) continue;
    const expected = segments(candidate.path);
    if (expected.length !== incoming.length) continue;
    let score = 0,
      matched = true;
    for (let index = 0; index < expected.length; index++) {
      const segment = expected[index];
      if (/^:[A-Za-z_][A-Za-z0-9_]*$/.test(segment) || /^\{\{[^{}]+\}\}$/.test(segment)) {
        if (!incoming[index] || incoming[index].includes("/")) matched = false;
      } else if (segment === incoming[index]) score++;
      else matched = false;
    }
    if (!matched) continue;
    if (options.matchQuery !== false && queryKey(candidate.query) !== queryKey(observation.query)) continue;
    if (options.matchBody !== false && canonicalBody(candidate.body) !== canonicalBody(observation.body))
      continue;
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}
