import { gunzipSync } from "node:zlib";
import { TELEMETRY_LIMITS, telemetryQuery } from "@/core/telemetry/model";
import { FixedWindowLimiter } from "@/core/ratelimit";
import { authenticateTelemetry, ingestTelemetry } from "./telemetry";
import { HttpError, isHttpError } from "./errors";
const state = globalThis as typeof globalThis & { __postboxTelemetryLimiter?: FixedWindowLimiter };
const limiter = () => (state.__postboxTelemetryLimiter ??= new FixedWindowLimiter());
export function telemetryQueryFromUrl(url: string) {
  const params = new URL(url).searchParams,
    now = Date.now();
  return telemetryQuery.parse({
    from: Number(params.get("from") ?? now - 3600000),
    to: Number(params.get("to") ?? now),
    sourceId: params.get("sourceId") || undefined,
    service: params.get("service") || undefined,
    environment: params.get("environment") || undefined,
    search: params.get("search") ?? "",
    errorsOnly: params.get("errorsOnly") === "true",
    offset: Number(params.get("offset") ?? 0),
    limit: Number(params.get("limit") ?? 50),
  });
}
export async function telemetryIntake(req: Request, id: string) {
  try {
    const bearer = req.headers.get("authorization") ?? "";
    if (!/^Bearer [A-Za-z0-9_-]{43}$/.test(bearer))
      throw new HttpError(401, "Ingestion bearer credential required");
    const token = bearer.slice(7);
    authenticateTelemetry(id, token);
    const decision = limiter().hit(id, 120, 60000, Date.now());
    if (!decision.allowed)
      return Response.json(
        { code: 8, message: "Telemetry intake rate exceeded" },
        { status: 429, headers: { "Retry-After": String(decision.resetSeconds) } },
      );
    if (req.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json")
      throw new HttpError(415, "Use OTLP/HTTP JSON");
    const encoding = req.headers.get("content-encoding")?.trim().toLowerCase() ?? "identity";
    if (encoding !== "gzip" && encoding !== "identity")
      throw new HttpError(415, "Unsupported content encoding");
    const limit = TELEMETRY_LIMITS.batchBytes;
    if (Number(req.headers.get("content-length")) > limit)
      throw new HttpError(413, "Telemetry batch exceeds 2 MiB");
    const chunks: Uint8Array[] = [],
      reader = req.body?.getReader();
    let size = 0;
    if (reader)
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) {
          void reader.cancel().catch(() => undefined);
          throw new HttpError(413, "Telemetry batch exceeds 2 MiB");
        }
        chunks.push(value);
      }
    let body: Uint8Array = Buffer.concat(chunks);
    if (encoding === "gzip") {
      try {
        body = gunzipSync(body, { maxOutputLength: limit });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE")
          throw new HttpError(413, "Decoded telemetry batch exceeds 2 MiB");
        throw new HttpError(400, "Invalid gzip body");
      }
    }
    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    } catch {
      throw new HttpError(400, "Invalid OTLP JSON");
    }
    const counts = ingestTelemetry(id, token, raw);
    return Response.json(
      counts.rejected
        ? {
            partialSuccess: {
              rejectedSpans: String(counts.rejected),
              errorMessage: "Invalid span metadata, timestamps or attribute limits",
            },
          }
        : {},
    );
  } catch (error) {
    const status = isHttpError(error) ? error.status : 500;
    return Response.json(
      {
        code: status === 401 ? 16 : status === 403 ? 7 : status === 429 ? 8 : status >= 500 ? 13 : 3,
        message: isHttpError(error) ? error.message : "Telemetry intake failed",
      },
      { status },
    );
  }
}
