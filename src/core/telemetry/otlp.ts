import { createHash } from "node:crypto";
import { TELEMETRY_LIMITS, type IntakeCounts, type Observation, type TelemetryConfig } from "./model";
type ObjectValue = Record<string, unknown>;
const object = (v: unknown): ObjectValue =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as ObjectValue) : {};
function attributes(raw: unknown) {
  if (raw === undefined) return new Map<string, unknown>();
  if (!Array.isArray(raw) || raw.length > TELEMETRY_LIMITS.attributes)
    throw Error("Attribute limit or shape");
  const result = new Map<string, unknown>();
  for (const item of raw) {
    const a = object(item);
    if (typeof a.key !== "string" || a.key.length > 200) continue;
    const value = object(a.value);
    result.set(a.key, value.stringValue ?? value.intValue);
  }
  return result;
}
const text = (value: unknown, max = 8192) =>
  typeof value === "string" && value.length <= max ? value : undefined;
function nanos(value: unknown) {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0) throw Error("Invalid timestamp");
    value = BigInt(value);
  } else if (typeof value === "string" && /^\d{1,20}$/.test(value)) value = BigInt(value);
  else throw Error("Invalid timestamp");
  if (typeof value !== "bigint" || value > BigInt("18446744073709551615")) throw Error("Invalid timestamp");
  return value;
}
/** Only configured public literal segments survive. Every other value becomes a placeholder. */
export function telemetryRoute(raw: string | undefined, segments: readonly string[]) {
  if (!raw) return "/[unmapped]";
  let path = raw;
  if (/^https?:\/\//i.test(path)) {
    try {
      path = new URL(path).pathname;
    } catch {
      return "/[unmapped]";
    }
  }
  path = path.split(/[?#]/, 1)[0];
  if (!path.startsWith("/") || path.length > 8192) return "/[unmapped]";
  const parts = path.split("/").filter(Boolean);
  if (parts.length > 30) return "/[unmapped]";
  const allowed = new Set(segments);
  return (
    "/" +
    parts
      .map((value) => {
        try {
          value = decodeURIComponent(value);
        } catch {
          return ":segment";
        }
        if (
          /^[:*]/.test(value) ||
          /^\{[^{}]{1,64}\}$/.test(value) ||
          /^\d+$/.test(value) ||
          /^[a-f0-9-]{16,}$/i.test(value)
        )
          return ":id";
        return allowed.has(value) ? value : ":segment";
      })
      .join("/")
  );
}
export function sampled(traceId: string, spanId: string, rate: number) {
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  return (
    createHash("sha256")
      .update(traceId + ":" + spanId)
      .digest()
      .readUInt32BE(0) /
      4294967296 <
    rate
  );
}
/** Decode only server HTTP span metadata; request/response payloads and arbitrary attributes are discarded. */
export function decodeTelemetry(raw: unknown, config: TelemetryConfig, now: number) {
  const counts: IntakeCounts = {
      received: 0,
      accepted: 0,
      sampledOut: 0,
      ignored: 0,
      rejected: 0,
      duplicates: 0,
      evicted: 0,
    },
    observations: Observation[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Error("Expected an OTLP request object");
  const root = object(raw),
    resources = root.resourceSpans ?? [];
  if (!Array.isArray(resources) || resources.length > TELEMETRY_LIMITS.resources)
    throw Error("Expected bounded resourceSpans array");
  for (const resourceItem of resources) {
    const resource = object(resourceItem),
      scopes = resource.scopeSpans ?? [];
    if (!Array.isArray(scopes) || scopes.length > TELEMETRY_LIMITS.scopes)
      throw Error("Expected bounded scopeSpans array");
    let service: unknown;
    try {
      service = attributes(object(resource.resource).attributes).get("service.name");
    } catch {
      service = null;
    }
    for (const scopeItem of scopes) {
      const spans = object(scopeItem).spans ?? [];
      if (!Array.isArray(spans) || spans.length + counts.received > TELEMETRY_LIMITS.spans)
        throw Error("At most 1000 spans per batch");
      for (const spanItem of spans) {
        counts.received++;
        const span = object(spanItem);
        if (service !== config.serviceName || span.kind !== 2) {
          counts.ignored++;
          continue;
        }
        try {
          const a = attributes(span.attributes),
            traceId = text(span.traceId, 32)?.toLowerCase(),
            spanId = text(span.spanId, 16)?.toLowerCase(),
            method = text(a.get("http.request.method") ?? a.get("http.method"), 20)?.toUpperCase();
          if (
            !traceId ||
            !spanId ||
            !/^[0-9a-f]{32}$/.test(traceId) ||
            !/^[0-9a-f]{16}$/.test(spanId) ||
            /^0+$/.test(traceId) ||
            /^0+$/.test(spanId)
          )
            throw Error("Invalid trace identity");
          if (!method || !/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE|CONNECT)$/.test(method)) {
            counts.ignored++;
            continue;
          }
          const start = nanos(span.startTimeUnixNano),
            end = nanos(span.endTimeUnixNano),
            at = Number(end / BigInt(1000000)),
            durationMs = Number(end - start) / 1e6;
          if (
            end < start ||
            durationMs > 3600000 ||
            at < now - config.retentionDays * 86400000 ||
            at > now + 120000
          )
            throw Error("Span timestamp outside retention or duration limits");
          const rawStatus = a.get("http.response.status_code") ?? a.get("http.status_code");
          let status: number | null = null;
          if (rawStatus !== undefined) {
            status =
              typeof rawStatus === "number"
                ? rawStatus
                : typeof rawStatus === "string" && /^\d{3}$/.test(rawStatus)
                  ? Number(rawStatus)
                  : NaN;
            if (!Number.isInteger(status) || status < 100 || status > 599) throw Error("Invalid HTTP status");
          }
          const template = text(a.get("http.route")),
            path = text(a.get("url.path") ?? a.get("http.target") ?? a.get("url.full") ?? a.get("http.url"));
          const route = telemetryRoute(template ?? path, config.staticSegments),
            routeSource = route === "/[unmapped]" ? "unknown" : template ? "template" : "path";
          if (!sampled(traceId, spanId, config.sampleRate)) {
            counts.sampledOut++;
            continue;
          }
          observations.push({
            traceId,
            spanId,
            method,
            route,
            routeSource,
            status,
            error: (status !== null && status >= 400) || object(span.status).code === 2,
            durationMs,
            at,
            service: config.serviceName,
            environment: config.environment,
            sampleRate: config.sampleRate,
          });
        } catch {
          counts.rejected++;
        }
      }
    }
  }
  return { counts, observations };
}
