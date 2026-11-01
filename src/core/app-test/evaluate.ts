import type { FolderNode, FolderDef, RequestDef, Variable, TestResult } from "../types";
import { emptyScopes, variablesToRecord, type VariableScopes } from "../variables/resolver";
import { runScript, type ScriptContext } from "../scripts/sandbox";
import { authCredentialValues } from "../retention";
import { captureSecrets, safeValue, type Observation } from "./capture";
export interface AppCollection {
  root: FolderNode;
  variables: Variable[];
}
interface Operation {
  id: string;
  name: string;
  path: string;
  request: RequestDef;
  ancestors: FolderDef[];
  scopes: VariableScopes;
}
export interface CallResult {
  index: number;
  method: string;
  url: string;
  operation?: string;
  state: "passed" | "failed" | "unmatched" | "ambiguous" | "no-assertions" | "missing-response";
  tests: TestResult[];
  errors: string[];
}
export interface AppTestReport {
  version: 1;
  mode: "observation-only";
  calls: CallResult[];
  operations: { id: string; name: string; path: string; matchedCalls: number; assertionCalls: number }[];
  summary: {
    passed: number;
    failed: number;
    unmatched: number;
    ambiguous: number;
    noAssertions: number;
    missingResponse: number;
    unexercised: number;
  };
  passed: boolean;
  commandExit?: number;
}
export interface EvaluateOptions {
  environment?: Variable[];
  target?: string;
  filter?: string;
  strictCoverage?: boolean;
}
function substitute(value: string, scopes: VariableScopes) {
  for (let depth = 0; depth < 10; depth++) {
    const next = value.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (all, key) => {
      for (const scope of [scopes.local, scopes.data, scopes.environment, scopes.collection, scopes.globals])
        if (Object.hasOwn(scope, key)) return scope[key];
      return all;
    });
    if (next === value) break;
    value = next;
  }
  return value;
}
function template(expected: string, actual: string, bindings: Record<string, string>) {
  const variable = expected.match(/^\{\{\s*([^{}]+?)\s*\}\}$/);
  if (variable) {
    const key = variable[1];
    if (Object.hasOwn(bindings, key)) return bindings[key] === actual;
    bindings[key] = actual;
    return true;
  }
  return expected === actual;
}
function bodyMatches(expected: unknown, actual: unknown, bindings: Record<string, string>): boolean {
  if (typeof expected === "string")
    return template(expected, typeof actual === "string" ? actual : JSON.stringify(actual), bindings);
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((e, i) => bodyMatches(e, actual[i], bindings))
    );
  if (expected && typeof expected === "object")
    return (
      !!actual &&
      typeof actual === "object" &&
      !Array.isArray(actual) &&
      Object.keys(expected).length === Object.keys(actual).length &&
      Object.entries(expected).every(
        ([key, value]) =>
          Object.hasOwn(actual, key) &&
          bodyMatches(value, (actual as Record<string, unknown>)[key], bindings),
      )
    );
  return expected === actual;
}
function candidate(
  op: Operation,
  entry: Observation,
  target?: string,
): { score: number; bindings: Record<string, string> } | undefined {
  if (op.request.method !== entry.request.method) return;
  let raw = substitute(op.request.url, op.scopes);
  if (target) raw = raw.replace(/^\{\{[^{}]+\}\}/, new URL(target).origin);
  let expected: URL;
  const actual = new URL(entry.request.url);
  try {
    expected = new URL(raw);
  } catch {
    return;
  }
  if (/\{\{|%7b/i.test(expected.host)) return;
  if (target) {
    const origin = new URL(target);
    if (
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash ||
      origin.username ||
      origin.password ||
      !/^https?:$/.test(origin.protocol)
    )
      throw new Error("Target must be an HTTP(S) origin");
    expected.host = origin.host;
    expected.protocol = origin.protocol;
  }
  if (expected.origin !== actual.origin) return;
  const decode = (value: string) => decodeURIComponent(value).replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, "{{$1}}");
  const parts = expected.pathname.split("/"),
    observed = actual.pathname.split("/"),
    bindings: Record<string, string> = Object.create(null);
  let score = 0;
  if (parts.length !== observed.length) return;
  try {
    for (let i = 0; i < parts.length; i++) {
      const part = decode(parts[i]);
      if (!template(part, decodeURIComponent(observed[i]), bindings)) return;
      if (!part.includes("{{")) score += part.length + 1;
    }
  } catch {
    return;
  }
  const query = new URLSearchParams(expected.search);
  for (const p of op.request.params.filter((p) => p.enabled && p.key)) {
    query.delete(substitute(p.key, op.scopes));
    for (const v of op.request.params.filter((q) => q.enabled && q.key === p.key))
      query.append(substitute(v.key, op.scopes), substitute(v.value, op.scopes));
  }
  for (const key of new Set(query.keys())) {
    const values = query.getAll(key),
      actualValues = actual.searchParams.getAll(key);
    if (
      values.length !== actualValues.length ||
      !values.every((v, i) => template(v, actualValues[i], bindings))
    )
      return;
    score += values.length;
  }
  const body = op.request.body;
  if (body.mode === "raw") {
    const expectedText = substitute(body.raw, op.scopes);
    if (entry.request.body === undefined) return;
    try {
      if (!bodyMatches(JSON.parse(expectedText), JSON.parse(entry.request.body), bindings)) return;
    } catch {
      if (!template(expectedText, entry.request.body, bindings)) return;
    }
    score++;
  } else if (body.mode === "urlencoded") {
    const values = new URLSearchParams(entry.request.body ?? "");
    for (const p of body.urlencoded.filter((p) => p.enabled)) {
      if (!values.has(p.key) || !template(substitute(p.value, op.scopes), values.get(p.key)!, bindings))
        return;
    }
    score++;
  } else if (body.mode !== "none") return;
  return { score, bindings };
}
export async function evaluateObservations(
  collections: AppCollection[],
  entries: Observation[],
  options: EvaluateOptions = {},
): Promise<AppTestReport> {
  if (options.target) {
    const target = new URL(options.target);
    if (
      !/^https?:$/.test(target.protocol) ||
      target.pathname !== "/" ||
      target.search ||
      target.hash ||
      target.username ||
      target.password
    )
      throw new Error("Target must be an HTTP(S) origin");
  }
  const deadline = Date.now() + 30000;
  let totalTests = 0;
  const operations: Operation[] = [],
    secrets = captureSecrets(entries);
  for (const [ci, c] of collections.entries()) {
    const scopes = {
      ...emptyScopes(),
      collection: variablesToRecord(c.variables),
      environment: variablesToRecord(options.environment ?? []),
    };
    for (const variable of [...c.variables, ...(options.environment ?? [])])
      if (variable.enabled && variable.type === "secret" && variable.value) secrets.push(variable.value);
    const walk = (folder: FolderNode, ancestors: FolderDef[]) => {
      secrets.push(...authCredentialValues(folder.auth));
      for (const [i, child] of folder.children.entries()) {
        if (child.kind === "folder") walk(child, [...ancestors, folder]);
        else {
          secrets.push(...authCredentialValues(child.auth));
          const path = [...ancestors, folder].map((f) => f.name).join(" / ");
          if (!options.filter || `${path} / ${child.name} ${child.url}`.includes(options.filter))
            operations.push({
              id: `${ci}:${operations.length}:${i}`,
              name: child.name,
              path,
              request: child,
              ancestors: [...ancestors, folder],
              scopes,
            });
        }
      }
    };
    walk(c.root, []);
  }
  if (!operations.length) throw new Error("No operations selected");
  if (operations.length > 1000) throw new Error("At most 1000 operations are supported");
  const coverage = operations.map((op) => ({
    id: op.id,
    name: op.name,
    path: op.path,
    matchedCalls: 0,
    assertionCalls: 0,
  }));
  const calls: CallResult[] = [];
  for (const [index, e] of entries.entries()) {
    if (Date.now() > deadline) throw new Error("Observation evaluation exceeded 30 seconds");
    const result: CallResult = {
      index,
      method: e.request.method,
      url: e.request.url,
      state: "unmatched",
      tests: [],
      errors: [],
    };
    const matches = operations
      .map((op, i) => ({ op, i, match: candidate(op, e, options.target) }))
      .filter((m) => m.match)
      .sort((a, b) => b.match!.score - a.match!.score);
    if (!matches.length) {
      calls.push(result);
      continue;
    }
    if (matches.length > 1 && matches[0].match!.score === matches[1].match!.score) {
      result.state = "ambiguous";
      result.errors.push("Multiple equally specific collection operations match");
      calls.push(result);
      continue;
    }
    const { op, i, match } = matches[0];
    coverage[i].matchedCalls++;
    result.operation = op.id;
    if (!e.response) {
      result.state = "missing-response";
      calls.push(result);
      continue;
    }
    const context: ScriptContext = {
      scopes: structuredClone(op.scopes),
      request: {
        id: op.request.id,
        name: op.name,
        url: e.request.url,
        method: e.request.method,
        headers: e.request.headers.map((h) => ({ key: h.name, value: h.value })),
        body: e.request.body === undefined ? null : { mode: "raw", raw: e.request.body },
      },
      response: {
        code: e.response.status,
        status: e.response.statusText,
        headers: e.response.headers.map((h) => ({ key: h.name, value: h.value })),
        body: e.response.body ?? "",
        responseTime: e.response.timeMs,
        responseSize: Buffer.byteLength(e.response.body ?? ""),
      },
      info: {
        eventName: "test",
        iteration: index,
        iterationCount: entries.length,
        requestName: op.name,
        requestId: op.request.id,
      },
    };
    context.scopes.local = { ...match!.bindings };
    let attemptedNetwork = false;
    const blocked = async () => {
      attemptedNetwork = true;
      throw new Error("Network calls are disabled in observation-only assertions");
    };
    for (const source of [...op.ancestors, op.request])
      if (source.testScript.trim()) {
        if (Date.now() > deadline) throw new Error("Observation evaluation exceeded 30 seconds");
        const evaluated = await runScript(source.testScript, context, {
          host: { sendRequest: blocked, runRequest: blocked },
          limits: { timeoutMs: 500, memoryBytes: 32 * 1024 * 1024, maxTimers: 50 },
          secrets,
          source: "Observed response assertions",
        });
        totalTests += evaluated.tests.length;
        if (totalTests > 10000) throw new Error("At most 10000 assertion results are supported");
        context.scopes = evaluated.scopes;
        const remaining = 1000 - result.tests.length;
        result.tests.push(...evaluated.tests.slice(0, remaining));
        if (evaluated.tests.length > remaining) result.errors.push("Assertion result limit reached");
        if (evaluated.error) result.errors.push(evaluated.error);
      }
    if (attemptedNetwork) result.errors.push("Network calls are disabled in observation-only assertions");
    if (e.response.body === undefined)
      result.errors.push("Captured response body unavailable; assertions are incomplete");
    result.state =
      result.errors.length || result.tests.some((t) => !t.passed && !t.skipped)
        ? "failed"
        : result.tests.some((t) => !t.skipped)
          ? "passed"
          : "no-assertions";
    if (result.tests.some((t) => !t.skipped)) coverage[i].assertionCalls++;
    calls.push(result);
  }
  const summary = {
    passed: 0,
    failed: 0,
    unmatched: 0,
    ambiguous: 0,
    noAssertions: 0,
    missingResponse: 0,
    unexercised: coverage.filter((o) => !o.matchedCalls).length,
  };
  for (const call of calls) {
    const key =
      call.state === "no-assertions"
        ? "noAssertions"
        : call.state === "missing-response"
          ? "missingResponse"
          : call.state;
    summary[key]++;
  }
  const report: AppTestReport = {
    version: 1,
    mode: "observation-only",
    calls,
    operations: coverage,
    summary,
    passed:
      summary.failed === 0 &&
      summary.missingResponse === 0 &&
      summary.ambiguous === 0 &&
      (!options.strictCoverage || (!summary.unmatched && !summary.noAssertions && !summary.unexercised)) &&
      summary.passed > 0,
  };
  return safeValue(report, secrets);
}
