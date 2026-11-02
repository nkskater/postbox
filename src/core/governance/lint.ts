import { createHash } from "node:crypto";
import path from "node:path";
import YAML, { LineCounter, isMap, isScalar, isSeq } from "yaml";
import { analyzeSpecification } from "../specifications/analyze";
import { specificationSource, type SpecificationSource, type SourceLocation } from "../specifications/model";
import { normalizeBundlePath } from "../convert/openapi-references";
import { stableJson } from "../specifications/merge";
import {
  governanceConfig,
  GOVERNANCE_LIMITS,
  type GovernanceConfig,
  type GovernanceRule,
  type GovernanceReport,
  type GovernanceDiagnostic,
} from "./model";
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const escape = (v: string) => v.replaceAll("~", "~0").replaceAll("/", "~1");
const parts = (pointer: string) =>
  pointer
    ? pointer
        .slice(1)
        .split("/")
        .map((p) => p.replaceAll("~1", "/").replaceAll("~0", "~"))
    : [];
const pointer = (tokens: string[]) => (tokens.length ? "/" + tokens.map(escape).join("/") : "");
const hash = (value: unknown) => createHash("sha256").update(stableJson(value)).digest("hex");
interface Located {
  definitions?: Obj;
  value: unknown;
  file: string;
  path: string[];
}
class Limit extends Error {}
/** Wildcards only; dynamic programming avoids user-controlled regular-expression execution. */
export function governanceGlob(
  pattern: string,
  value: string,
  budget = { left: GOVERNANCE_LIMITS.work as number },
) {
  if ((pattern.length + 1) * (value.length + 1) > budget.left)
    throw new Limit("Governance matching work limit reached");
  budget.left -= (pattern.length + 1) * (value.length + 1);
  const characters = Array.from(value);
  let previous = new Uint8Array(characters.length + 1);
  previous[0] = 1;
  for (const char of pattern) {
    const next = new Uint8Array(characters.length + 1);
    if (char === "*") next[0] = previous[0];
    for (let j = 1; j <= characters.length; j++)
      next[j] =
        char === "*"
          ? previous[j] || next[j - 1]
          : char === "?" || char === characters[j - 1]
            ? previous[j - 1]
            : 0;
    previous = next;
  }
  return previous[characters.length] === 1;
}
function pointerMatches(pattern: string[], value: string[], budget: { left: number }, i = 0, j = 0): boolean {
  if (--budget.left < 0) throw new Limit("Governance matching work limit reached");
  if (i === pattern.length) return j === value.length;
  if (pattern[i] === "**")
    return (
      pointerMatches(pattern, value, budget, i + 1, j) ||
      (j < value.length && pointerMatches(pattern, value, budget, i, j + 1))
    );
  return (
    j < value.length &&
    (pattern[i] === "*" || pattern[i] === value[j]) &&
    pointerMatches(pattern, value, budget, i + 1, j + 1)
  );
}
function selected(root: Located, pattern: string, budget: { left: number }): Located[] {
  const tokens = parts(pattern),
    seenMatches = new Set<string>(),
    result: Located[] = [];
  const walk = (item: Located, index: number, depth = 0) => {
    if (--budget.left < 0 || depth > 60) throw new Limit("Governance selector work/depth limit reached");
    if (index === tokens.length) {
      const key = pointer(item.path);
      if (seenMatches.has(key)) return;
      seenMatches.add(key);
      if (result.length >= GOVERNANCE_LIMITS.evaluations)
        throw new Limit("Governance selector match limit reached");
      result.push(item);
      return;
    }
    const token = tokens[index];
    if (token === "**") walk(item, index + 1, depth);
    if (item.value === null || typeof item.value !== "object") return;
    if (token === "*" || token === "**") {
      for (const [key, value] of Object.entries(item.value))
        walk({ ...item, value, path: [...item.path, key] }, token === "**" ? index : index + 1, depth + 1);
    } else if (Object.hasOwn(item.value, token))
      walk({ ...item, value: (item.value as Obj)[token], path: [...item.path, token] }, index + 1, depth + 1);
  };
  walk(root, 0);
  return result;
}
function nested(value: unknown, tokens: string[]) {
  let current = value;
  for (const key of tokens) {
    if (!current || typeof current !== "object" || !Object.hasOwn(current, key)) return undefined;
    current = (current as Obj)[key];
  }
  return current;
}
function check(
  rule: GovernanceRule,
  value: unknown,
  seen: Set<string>,
  budget: { left: number },
  definitions: Obj = {},
): boolean {
  budget.left -= typeof value === "string" ? value.length : Array.isArray(value) ? value.length : 1;
  if (budget.left < 0) throw new Limit("Governance check work limit reached");
  const test = rule.check;
  const string = typeof value === "string" ? value : "";
  switch (test.kind) {
    case "required":
      return value !== undefined && value !== null;
    case "forbidden":
      return value === undefined;
    case "nonEmpty":
      return typeof value === "string"
        ? !!value.trim()
        : Array.isArray(value)
          ? value.length > 0
          : !!value && typeof value === "object"
            ? Object.keys(value).length > 0
            : false;
    case "unique": {
      if (value === undefined) return true;
      const key = stableJson(value);
      budget.left -= key.length;
      if (budget.left < 0) throw new Limit("Governance uniqueness work limit reached");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }
    case "type":
      return test.value === "array"
        ? Array.isArray(value)
        : test.value === "object"
          ? !!value && typeof value === "object" && !Array.isArray(value)
          : typeof value === test.value;
    case "equals":
      return value === test.value;
    case "notEquals":
      return value !== test.value;
    case "oneOf":
      return test.values.some((v) => v === value);
    case "minLength":
      return (typeof value === "string" || Array.isArray(value)) && value.length >= test.value;
    case "startsWith":
      return typeof value === "string" && value.startsWith(test.value);
    case "endsWith":
      return typeof value === "string" && value.endsWith(test.value);
    case "contains":
      return typeof value === "string" && value.includes(test.value);
    case "matches":
      return typeof value === "string" && governanceGlob(test.value, value, budget);
    case "casing":
      return (
        typeof value === "string" &&
        {
          camel: /^[a-z][A-Za-z0-9]*$/,
          pascal: /^[A-Z][A-Za-z0-9]*$/,
          snake: /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/,
          kebab: /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/,
          lower: /^[a-z0-9]+$/,
        }[test.value].test(value)
      );
    case "pathKebab":
      return (
        typeof value === "string" &&
        value
          .split("/")
          .filter(Boolean)
          .every((segment) => /^\{[^{}]+\}$/.test(segment) || /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(segment))
      );
    case "https": {
      const object = obj(value),
        url = typeof value === "string" ? value : String(object.url ?? ""),
        protocol = String(object.protocol ?? "").toLowerCase();
      return (
        /^(https|wss):\/\//i.test(url) ||
        ["https", "wss", "mqtts", "amqps", "kafka-secure", "ibmmq-secure"].includes(protocol)
      );
    }
    case "securityReferences":
      return (
        value === undefined ||
        (Array.isArray(value) &&
          value.every(
            (entry) =>
              !!entry &&
              typeof entry === "object" &&
              Object.entries(entry).every(
                ([name, scopes]) =>
                  Object.hasOwn(definitions, name) &&
                  Array.isArray(scopes) &&
                  scopes.every((scope) => typeof scope === "string"),
              ),
          ))
      );
    case "security":
      return (
        Array.isArray(value) &&
        value.length > 0 &&
        value.every(
          (entry) =>
            !!entry && typeof entry === "object" && !Array.isArray(entry) && Object.keys(entry).length > 0,
        )
      );
    default:
      return !!string;
  }
}
export function lintGovernance(
  rawSource: SpecificationSource,
  rawConfig: GovernanceConfig,
): GovernanceReport {
  const parsedSource = specificationSource.parse(rawSource),
    source = {
      ...parsedSource,
      files: [...parsedSource.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    },
    config = governanceConfig.parse(rawConfig),
    analysis = analyzeSpecification(source),
    report: GovernanceReport = {
      reportVersion: 1,
      sourceHash: hash({
        ...source,
        files: [...source.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
      }),
      rulesHash: hash(config),
      complete: !analysis.truncated,
      diagnostics: analysis.diagnostics.map((d) => ({ ...d, ruleId: "syntax-" + d.code, path: "" })),
      summary: { errors: 0, warnings: 0, info: 0, evaluated: 0, excluded: 0, disabled: 0, notApplicable: 0 },
    };
  let evaluations = 0;
  const budget = { left: GOVERNANCE_LIMITS.work as number },
    documents = new Map<string, unknown>(),
    locations = new Map<string, Map<string, SourceLocation>>();

  const locate = (file: string, tokens: string[]): SourceLocation => {
    const map = locations.get(file);
    for (let n = tokens.length; n >= 0; n--) {
      const location = map?.get(pointer(tokens.slice(0, n)));
      if (location) return location;
    }
    return { file, line: 1, column: 1 };
  };
  const append = (diagnostic: GovernanceDiagnostic) => {
    if (report.diagnostics.length >= GOVERNANCE_LIMITS.diagnostics)
      throw new Limit("Governance diagnostic limit reached");
    report.diagnostics.push(diagnostic);
  };
  if (analysis.diagnostics.some((d) => d.code === "limit" || d.code === "file")) {
    report.complete = false;
    for (const d of report.diagnostics) report.summary[d.severity === "error" ? "errors" : "warnings"]++;
    return report;
  }
  try {
    for (const file of source.files) {
      if (
        ["openapi", "asyncapi"].includes(source.format) ||
        (source.format === "smithy" && file.content.trimStart().startsWith("{"))
      ) {
        try {
          const lineCounter = new LineCounter();
          const doc = YAML.parseDocument(file.content, { uniqueKeys: true, lineCounter });
          if (doc.errors.length) continue;
          const value = doc.toJS({ maxAliasCount: 0 }),
            map = new Map<string, SourceLocation>();
          let count = 0;
          const at = (offset: number) => {
            const pos = lineCounter.linePos(offset);
            return { file: file.path, line: pos.line, column: pos.col };
          };
          const walk = (node: unknown, tokens: string[], depth = 0) => {
            if (++count > 50000 || depth > 60)
              throw new Limit("Governance document node/depth limit reached");
            const n = node as { range?: number[] } | null;
            map.set(pointer(tokens), at(n?.range?.[0] ?? 0));
            if (isMap(node))
              for (const pair of node.items)
                walk(pair.value, [...tokens, String(isScalar(pair.key) ? pair.key.value : "")], depth + 1);
            else if (isSeq(node))
              node.items.forEach((child, i) => walk(child, [...tokens, String(i)], depth + 1));
          };
          walk(doc.contents, []);
          documents.set(file.path, value);
          locations.set(file.path, map);
        } catch (error) {
          if (error instanceof Limit) throw error;
        }
      }
    }
    const resolve = (item: Located, seen = new Set<string>()): Located => {
      const ref = obj(item.value).$ref;
      if (typeof ref !== "string") return item;
      const key = item.file + ":" + ref;
      if (seen.has(key) || seen.size > 32) return item;
      if (/^[a-z][\w+.-]*:/i.test(ref) || ref.startsWith("//")) return item;
      const [name, fragment = ""] = ref.split("#");
      try {
        const file = name
            ? normalizeBundlePath(
                path.posix.normalize(
                  path.posix.join(path.posix.dirname(item.file), decodeURIComponent(name)),
                ),
              )
            : item.file,
          decoded = decodeURIComponent(fragment);
        if (decoded && !decoded.startsWith("/")) return item;
        const target = parts(decoded),
          value = nested(documents.get(file), target);
        return value === undefined ? item : resolve({ value, file, path: target }, new Set([...seen, key]));
      } catch {
        return item;
      }
    };
    const root = documents.get(source.entrypoint),
      entry: Located = { value: root, file: source.entrypoint, path: [] },
      scopes = new Map<string, Located[]>();
    const operationItems: Located[] = [],
      pathItems: Located[] = [],
      serverItems: Located[] = [];
    const addServers = (value: unknown, file: string, tokens: string[]) => {
      if (value && typeof value === "object")
        for (const [key, server] of Object.entries(value))
          serverItems.push(resolve({ value: server, file, path: [...tokens, key] }));
    };
    addServers(obj(root).servers, source.entrypoint, ["servers"]);
    if (source.format === "openapi")
      for (const [url, value] of Object.entries(obj(obj(root).paths))) {
        const pathItem = resolve({ value, file: source.entrypoint, path: ["paths", url] });
        pathItems.push({ ...pathItem, path: [...pathItem.path], value: { [url]: pathItem.value } });
        addServers(obj(pathItem.value).servers, pathItem.file, [...pathItem.path, "servers"]);
        for (const [method, operation] of Object.entries(obj(pathItem.value))) {
          if (!/^(get|post|put|patch|delete|head|options|trace)$/.test(method)) continue;
          const item = resolve({ value: operation, file: pathItem.file, path: [...pathItem.path, method] });
          operationItems.push({
            ...item,
            definitions: obj(obj(obj(root).components).securitySchemes ?? obj(root).securityDefinitions),
            value: {
              ...obj(item.value),
              security:
                obj(item.value).security === undefined ? obj(root).security : obj(item.value).security,
            },
          });
          addServers(obj(item.value).servers, item.file, [...item.path, "servers"]);
        }
      }
    if (source.format === "openapi" && obj(root).swagger === "2.0") {
      for (const [index, scheme] of (Array.isArray(obj(root).schemes)
        ? (obj(root).schemes as unknown[])
        : []
      ).entries())
        serverItems.push({
          value: { url: String(scheme) + "://" + String(obj(root).host ?? "") },
          file: source.entrypoint,
          path: ["schemes", String(index)],
        });
    }
    if (source.format === "asyncapi") {
      for (const [key, value] of Object.entries(obj(obj(root).operations)))
        operationItems.push({
          value: { operationId: key, ...obj(value) },
          file: source.entrypoint,
          path: ["operations", key],
        });
      for (const [channel, value] of Object.entries(obj(obj(root).channels)))
        for (const method of ["publish", "subscribe"])
          if (obj(value)[method])
            operationItems.push({
              value: obj(value)[method],
              file: source.entrypoint,
              path: ["channels", channel, method],
            });
    }
    const virtual = (items: Located[]) => items.map((item) => ({ ...item, value: [item.value] }));
    scopes.set("operations", virtual(operationItems));
    scopes.set("servers", virtual(serverItems));
    scopes.set("paths", pathItems);
    scopes.set(
      "symbols",
      analysis.symbols.map((item) => ({ file: item.file, path: [], value: [item] })),
    );
    scopes.set(
      "references",
      analysis.references.map((item) => ({ file: item.file, path: [], value: [item] })),
    );
    for (const rule of config.rules) {
      const level = config.overrides[rule.id] ?? rule.severity;
      if (level === "off") {
        report.summary.disabled++;
        continue;
      }
      if (!rule.formats.includes(source.format)) {
        report.summary.notApplicable++;
        continue;
      }
      const roots =
        rule.scope === "document"
          ? rule.files === "all"
            ? [...documents].map(([file, value]) => ({ file, value, path: [] }))
            : [entry]
          : (scopes.get(rule.scope) ?? []);
      if (!roots.length || roots.every((r) => r.value === undefined)) {
        report.summary.notApplicable++;
        continue;
      }
      const seen = new Set<string>();
      let matched = false;
      for (const scope of roots) {
        if (rule.files === "entrypoint" && scope.file !== source.entrypoint && rule.scope === "document")
          continue;
        for (const match of selected(scope, rule.given, budget)) {
          matched = true;
          if (++evaluations > GOVERNANCE_LIMITS.evaluations)
            throw new Limit("Governance evaluation limit reached");
          const virtualOffset = ["operations", "paths", "servers", "symbols", "references"].includes(
              rule.scope,
            )
              ? 1
              : 0,
            actualPath = virtualOffset
              ? [...scope.path, ...match.path.slice(scope.path.length + 1)]
              : match.path;
          const tokens = [...actualPath, ...parts(rule.field)],
            at = { ...locate(match.file, tokens) };
          if (rule.scope === "symbols" || rule.scope === "references") {
            const origin = Array.isArray(scope.value) ? (scope.value[0] as SourceLocation) : undefined;
            if (origin) {
              at.file = origin.file;
              at.line = origin.line;
              at.column = origin.column;
            }
          }
          let excluded = false;
          for (const exclusion of config.exclusions) {
            if (
              (exclusion.ruleId === "*" || exclusion.ruleId === rule.id) &&
              governanceGlob(exclusion.file, match.file, budget) &&
              pointerMatches(parts(exclusion.path), tokens, budget)
            ) {
              excluded = true;
              break;
            }
          }
          if (excluded) {
            report.summary.excluded++;
            continue;
          }
          report.summary.evaluated++;
          const value = rule.target === "key" ? match.path.at(-1) : nested(match.value, parts(rule.field));
          if (!check(rule, value, seen, budget, match.definitions))
            append({
              ...at,
              ruleId: rule.id,
              severity: level,
              message: rule.message,
              path: pointer(tokens).slice(0, 2000),
            });
        }
      }
      if (!matched) report.summary.notApplicable++;
    }
  } catch (error) {
    if (!(error instanceof Limit)) throw error;
    report.complete = false;
    report.diagnostics.push({
      file: source.entrypoint,
      line: 1,
      column: 1,
      ruleId: "governance-limit",
      severity: "error",
      path: "",
      message: error.message,
    });
  }
  const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  report.diagnostics.sort((a, b) =>
    compare(a.file, b.file) ||
    a.line - b.line ||
    a.column - b.column ||
    compare(a.ruleId, b.ruleId) ||
    a.path < b.path
      ? -1
      : a.path > b.path
        ? 1
        : 0,
  );
  for (const d of report.diagnostics)
    report.summary[d.severity === "error" ? "errors" : d.severity === "warning" ? "warnings" : "info"]++;
  return report;
}
