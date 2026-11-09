import { z } from "zod";
import type { AuthConfig, BodyConfig, KeyValue } from "../types";
import type { StoredObservation } from "./model";

/**
 * Turns one captured production failure into an editable, unsent request draft.
 *
 * Telemetry deliberately keeps only redacted metadata (method, normalized route, status,
 * timing and trace identity), so a reproduction is always a starting point: the caller
 * explicitly maps the discarded host and route placeholders onto a target environment,
 * and every field that production never revealed is reported as a gap.
 */

/** Methods that are safe to replay without changing server state. Anything else is treated as side-effectful. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS", "TRACE"]);
export const isSideEffectful = (method: string) => !SAFE_METHODS.has(method.trim().toUpperCase());

export const UNMAPPED_ROUTE = "/[unmapped]";
const VARIABLE_ONLY = /^\{\{\s*[A-Za-z_][\w.-]{0,127}\s*\}\}$/;
const VARIABLE_REF = /\{\{\s*([A-Za-z_][\w.-]{0,127})\s*\}\}/g;

/** Redacted evidence of a single failed production span. Never modified by planning. */
export type FailureEvidence = Pick<
  StoredObservation,
  | "id"
  | "sourceId"
  | "sourceRevision"
  | "traceId"
  | "spanId"
  | "method"
  | "route"
  | "routeSource"
  | "status"
  | "error"
  | "durationMs"
  | "at"
  | "service"
  | "environment"
  | "sampleRate"
>;

export const reproMapping = z
  .object({
    /** Target base URL, e.g. `{{baseUrl}}` or `https://staging.example.com/v2`. Replaces the discarded production host. */
    baseUrl: z.string().trim().max(2048),
    /** Values for each route placeholder, in route order. A value may be a `{{variable}}` reference. */
    pathValues: z.array(z.string().max(1024)).max(30).default([]),
    /** Explicit path, required only when the production route could not be mapped. */
    path: z.string().trim().max(8192).optional(),
    /** Target environment the draft should resolve against. */
    environmentId: z.string().max(200).nullable().default(null),
    /** Variable keys defined in the target environment; used to report unresolved references. */
    environmentVariables: z.array(z.string().max(256)).max(2000).optional(),
    /** Required before a draft for a side-effectful method is produced. */
    acknowledgeSideEffects: z.boolean().default(false),
  })
  .strict();
export type ReproMapping = z.infer<typeof reproMapping>;

export interface RoutePlaceholder {
  /** Position among placeholders (0-based); matches `pathValues`. */
  index: number;
  /** Position among all route segments (0-based). */
  segment: number;
  /** `id` for identifiers/template parameters, `segment` for non-allowlisted literal words. */
  kind: "id" | "segment";
}

export type ReproGapField =
  | "host"
  | "path"
  | "query"
  | "headers"
  | "cookies"
  | "body"
  | "auth"
  | "method"
  | "variables"
  | "errorMessage";

export interface ReproGap {
  field: ReproGapField;
  /** `blocking` prevents a draft; `warning` needs attention before replay; `info` explains redaction. */
  severity: "blocking" | "warning" | "info";
  message: string;
}

export interface ReproDraft {
  name: string;
  method: string;
  url: string;
  params: KeyValue[];
  headers: KeyValue[];
  body: BodyConfig;
  auth: AuthConfig;
  description: string;
}

export interface ReproPlan {
  ready: boolean;
  sideEffectful: boolean;
  placeholders: RoutePlaceholder[];
  gaps: ReproGap[];
  url: string | null;
  environmentId: string | null;
  draft: ReproDraft | null;
  evidence: Readonly<FailureEvidence>;
}

/** Copies only the known evidence fields and freezes them so planning can never alter the original record. */
export function captureEvidence(source: FailureEvidence): Readonly<FailureEvidence> {
  return Object.freeze({
    id: source.id,
    sourceId: source.sourceId,
    sourceRevision: source.sourceRevision,
    traceId: source.traceId,
    spanId: source.spanId,
    method: source.method,
    route: source.route,
    routeSource: source.routeSource,
    status: source.status,
    error: source.error,
    durationMs: source.durationMs,
    at: source.at,
    service: source.service,
    environment: source.environment,
    sampleRate: source.sampleRate,
  });
}

export function routePlaceholders(route: string): RoutePlaceholder[] {
  if (route === UNMAPPED_ROUTE) return [];
  const result: RoutePlaceholder[] = [];
  route
    .split("/")
    .filter(Boolean)
    .forEach((part, segment) => {
      if (part === ":id" || part === ":segment")
        result.push({ index: result.length, segment, kind: part === ":id" ? "id" : "segment" });
    });
  return result;
}

/** Variable names referenced as `{{name}}` in the given strings, in first-seen order. */
export function referencedVariables(...values: string[]): string[] {
  const names = new Set<string>();
  for (const value of values) for (const match of value.matchAll(VARIABLE_REF)) names.add(match[1]);
  return [...names];
}

function validateBaseUrl(raw: string): { value: string } | { error: string } {
  const value = raw.trim().replace(/\/+$/, "");
  if (!value) return { error: "Enter a target base URL or {{variable}} for the discarded production host" };
  if (/^\{\{/.test(value)) {
    if (!/^\{\{\s*[A-Za-z_][\w.-]{0,127}\s*\}\}(\/[^\s?#]*)?$/.test(value))
      return {
        error: "Base URL must be a {{variable}} optionally followed by a path, without query or fragment",
      };
    return { value };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { error: "Base URL must be an http(s) URL or a {{variable}} reference" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return { error: "Base URL must use http or https" };
  if (url.username || url.password) return { error: "Base URL must not embed credentials" };
  if (url.search || url.hash) return { error: "Base URL must not contain a query or fragment" };
  return { value };
}

function encodeValue(value: string) {
  const trimmed = value.trim();
  if (VARIABLE_ONLY.test(trimmed)) return trimmed;
  return encodeURIComponent(trimmed);
}

function buildPath(evidence: FailureEvidence, mapping: ReproMapping, gaps: ReproGap[]): string | null {
  if (evidence.route === UNMAPPED_ROUTE) {
    const path = mapping.path?.trim() ?? "";
    if (!path) {
      gaps.push({
        field: "path",
        severity: "blocking",
        message: "Production route could not be mapped; enter the path to reproduce explicitly.",
      });
      return null;
    }
    if (!path.startsWith("/") || /[?#\s]/.test(path)) {
      gaps.push({
        field: "path",
        severity: "blocking",
        message: "Path must start with / and must not contain a query, fragment or whitespace.",
      });
      return null;
    }
    return path;
  }
  let missing = 0,
    index = 0;
  const parts = evidence.route
    .split("/")
    .filter(Boolean)
    .map((part) => {
      if (part !== ":id" && part !== ":segment") return part;
      const value = mapping.pathValues[index++] ?? "";
      if (!value.trim()) {
        missing++;
        return part;
      }
      return encodeValue(value);
    });
  if (missing)
    gaps.push({
      field: "path",
      severity: "blocking",
      message: `${missing} route placeholder${missing === 1 ? " needs" : "s need"} a value or {{variable}}; production identifiers were redacted.`,
    });
  if (evidence.routeSource === "path")
    gaps.push({
      field: "path",
      severity: "info",
      message:
        "Route was inferred from the URL path; non-allowlisted literal segments appear as placeholders.",
    });
  return missing ? null : "/" + parts.join("/");
}

function describe(evidence: FailureEvidence, gaps: readonly ReproGap[], environmentId: string | null) {
  const lines = [
    "Reproduction draft created from a captured production failure. Nothing has been sent.",
    "",
    "**Original evidence (read-only)**",
    "",
    `- Endpoint: \`${evidence.method} ${evidence.route}\` (${evidence.routeSource} route)`,
    `- Result: HTTP ${evidence.status ?? "unknown"}${evidence.error ? ", marked as error" : ""}, ${Number(evidence.durationMs.toFixed(2))} ms`,
    `- Observed: ${new Date(evidence.at).toISOString()}`,
    `- Service: ${evidence.service} · environment ${evidence.environment}`,
    `- Source: ${evidence.sourceId} (revision ${evidence.sourceRevision}, ${evidence.sampleRate * 100}% sampling)`,
    `- Trace: \`${evidence.traceId}\` · span \`${evidence.spanId}\``,
    `- Observation: \`${evidence.id}\``,
  ];
  if (environmentId) lines.push(`- Target environment: \`${environmentId}\``);
  const open = gaps.filter((g) => g.severity !== "blocking");
  if (open.length) {
    lines.push("", "**Missing or redacted context**", "");
    for (const gap of open) lines.push(`- [${gap.severity}] ${gap.field}: ${gap.message}`);
  }
  return lines.join("\n");
}

/**
 * Plans a reproduction for one failure. Pure and deterministic: it never sends anything and
 * never mutates `source`. `ready` is false while any blocking gap remains.
 */
export function planRepro(source: FailureEvidence, rawMapping: z.input<typeof reproMapping>): ReproPlan {
  const evidence = captureEvidence(source),
    mapping = reproMapping.parse(rawMapping),
    method = evidence.method.trim().toUpperCase(),
    sideEffectful = isSideEffectful(method),
    gaps: ReproGap[] = [];

  const base = validateBaseUrl(mapping.baseUrl);
  if ("error" in base) gaps.push({ field: "host", severity: "blocking", message: base.error });
  else
    gaps.push({
      field: "host",
      severity: "info",
      message: "Production host was discarded at ingestion; the draft targets the mapped base URL.",
    });

  const path = buildPath(evidence, mapping, gaps);

  if (sideEffectful)
    gaps.push({
      field: "method",
      severity: mapping.acknowledgeSideEffects ? "warning" : "blocking",
      message: mapping.acknowledgeSideEffects
        ? `${method} can create, change or delete data. Replay only against a non-production target, deliberately.`
        : `${method} can create, change or delete data. Confirm the side effects before a draft is created.`,
    });

  const authFailure = evidence.status === 401 || evidence.status === 403;
  gaps.push({
    field: "auth",
    severity: authFailure ? "warning" : "info",
    message: authFailure
      ? `Production returned HTTP ${evidence.status}. Credentials were never captured, so the failure depends on auth you must configure for the target environment.`
      : "Credentials were never captured. Configure auth for the target environment before replaying.",
  });

  gaps.push({
    field: "body",
    severity: sideEffectful && method !== "DELETE" ? "warning" : "info",
    message:
      sideEffectful && method !== "DELETE"
        ? "Request body was not captured. Supply a representative body before replaying."
        : "Request body was not captured.",
  });
  gaps.push({ field: "query", severity: "info", message: "Query parameters were not captured." });
  gaps.push({ field: "headers", severity: "info", message: "Request headers were not captured." });
  gaps.push({ field: "cookies", severity: "info", message: "Cookies were not captured." });
  gaps.push({
    field: "errorMessage",
    severity: "info",
    message:
      "Response body and error messages were discarded; correlate the trace ID with your tracing backend.",
  });

  const url = "value" in base && path !== null ? base.value + path : null;
  if (url && mapping.environmentVariables) {
    const defined = new Set(mapping.environmentVariables),
      unresolved = referencedVariables(url).filter((name) => !defined.has(name));
    if (unresolved.length)
      gaps.push({
        field: "variables",
        severity: "warning",
        message: `Not defined in the target environment: ${unresolved.map((n) => `{{${n}}}`).join(", ")}.`,
      });
  }

  const ready = !gaps.some((g) => g.severity === "blocking") && url !== null;
  const draft: ReproDraft | null = ready
    ? {
        name: `Repro: ${method} ${evidence.route} (HTTP ${evidence.status ?? "unknown"})`.slice(0, 200),
        method,
        url: url!,
        params: [],
        headers: [],
        body: { mode: "none" },
        auth: { type: "inherit" },
        description: describe(evidence, gaps, mapping.environmentId),
      }
    : null;
  return {
    ready,
    sideEffectful,
    placeholders: routePlaceholders(evidence.route),
    gaps,
    url,
    environmentId: mapping.environmentId,
    draft,
    evidence,
  };
}
