import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { z } from "zod";
import {
  TELEMETRY_LIMITS,
  telemetryConfig,
  telemetryQuery,
  type TelemetryQuery,
} from "@/core/telemetry/model";
import { decodeTelemetry } from "@/core/telemetry/otlp";
import { aggregateTelemetry, telemetryEndpoint } from "@/core/telemetry/metrics";
import { getDb, schema } from "./db";
import { authorize } from "./authorize";
import { currentCaller } from "./access-context";
import { HttpError } from "./errors";
import { newId } from "./defaults";
import { assertStorage } from "./usage";
const { telemetrySources: sources, telemetryObservations: observations } = schema;
const digest = (token: string) => createHash("sha256").update(token).digest("hex");
const secret = () => randomBytes(32).toString("base64url");
type Source = typeof sources.$inferSelect;
const publicSource = ({ tokenHash, ...row }: Source) => ({ ...row, credentialConfigured: !!tokenHash });
export const createTelemetryInput = z
  .object({ workspaceId: z.string().min(1), config: telemetryConfig })
  .strict();
export const saveTelemetryInput = z
  .object({ expectedRevision: z.number().int().positive(), config: telemetryConfig })
  .strict();
export const rotateTelemetryInput = z.object({ expectedRevision: z.number().int().positive() }).strict();
export function requireTelemetrySource(id: string, action: "read" | "write" = "read") {
  const row = getDb().select().from(sources).where(eq(sources.id, id)).get();
  if (!row) throw new HttpError(404, "Telemetry source not found");
  authorize(currentCaller(), row.workspaceId, action);
  return row;
}
export function listTelemetrySources(workspaceId: string) {
  authorize(currentCaller(), workspaceId, "read");
  return getDb().select().from(sources).where(eq(sources.workspaceId, workspaceId)).all().map(publicSource);
}
export function getTelemetrySource(id: string) {
  return publicSource(requireTelemetrySource(id));
}
export function createTelemetrySource(raw: z.input<typeof createTelemetryInput>) {
  const input = createTelemetryInput.parse(raw);
  authorize(currentCaller(), input.workspaceId, "write");
  assertStorage(input.workspaceId);
  return getDb().transaction((tx) => {
    if (
      tx.select().from(sources).where(eq(sources.workspaceId, input.workspaceId)).all().length >=
      TELEMETRY_LIMITS.sources
    )
      throw new HttpError(429, "At most 25 telemetry sources per workspace");
    const token = secret(),
      now = Date.now();
    const row = tx
      .insert(sources)
      .values({
        id: newId(),
        workspaceId: input.workspaceId,
        config: input.config,
        tokenHash: digest(token),
        revision: 1,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    return { source: publicSource(row), token };
  });
}
export function saveTelemetrySource(id: string, raw: z.input<typeof saveTelemetryInput>) {
  const input = saveTelemetryInput.parse(raw),
    row = requireTelemetrySource(id, "write");
  assertStorage(row.workspaceId);
  return getDb().transaction((tx) => {
    if (input.config.enabled && !row.tokenHash)
      throw new HttpError(409, "Rotate the ingestion credential before enabling this source");
    const saved = tx
      .update(sources)
      .set({ config: input.config, revision: row.revision + 1, updatedAt: Date.now() })
      .where(and(eq(sources.id, id), eq(sources.revision, input.expectedRevision)))
      .returning()
      .get();
    if (!saved) throw new HttpError(409, "Source changed; reload before saving");
    pruneTelemetry(Date.now(), row.workspaceId);
    return publicSource(saved);
  });
}
export function rotateTelemetrySource(id: string, raw: z.input<typeof rotateTelemetryInput>) {
  const input = rotateTelemetryInput.parse(raw),
    row = requireTelemetrySource(id, "write"),
    token = secret();
  const saved = getDb()
    .update(sources)
    .set({ tokenHash: digest(token), revision: row.revision + 1, updatedAt: Date.now() })
    .where(and(eq(sources.id, id), eq(sources.revision, input.expectedRevision)))
    .returning()
    .get();
  if (!saved) throw new HttpError(409, "Source changed; reload before rotating");
  return { source: publicSource(saved), token };
}
export function deleteTelemetrySource(id: string) {
  requireTelemetrySource(id, "write");
  getDb().delete(sources).where(eq(sources.id, id)).run();
  return { ok: true };
}
export function purgeTelemetrySource(id: string) {
  requireTelemetrySource(id, "write");
  const result = getDb().delete(observations).where(eq(observations.sourceId, id)).run();
  return { deleted: result.changes };
}
/** TTL and count bounds apply even to idle or disabled sources. */
export function pruneTelemetry(now = Date.now(), workspaceId?: string) {
  const db = getDb();
  return db.transaction((tx) => {
    const rows = tx
      .select()
      .from(sources)
      .where(workspaceId ? eq(sources.workspaceId, workspaceId) : undefined)
      .all();
    let deleted = 0;
    for (const source of rows) {
      deleted += tx
        .delete(observations)
        .where(
          and(
            eq(observations.sourceId, source.id),
            lt(observations.at, now - source.config.retentionDays * 86400000),
          ),
        )
        .run().changes;
      deleted += tx
        .delete(observations)
        .where(
          sql`${observations.id} IN (SELECT id FROM telemetry_observations WHERE source_id = ${source.id} ORDER BY at DESC, id DESC LIMIT -1 OFFSET ${source.config.maxObservations})`,
        )
        .run().changes;
    }
    for (const ws of new Set(rows.map((s) => s.workspaceId)))
      deleted += tx
        .delete(observations)
        .where(
          sql`${observations.id} IN (SELECT id FROM telemetry_observations WHERE workspace_id = ${ws} ORDER BY at DESC, id DESC LIMIT -1 OFFSET ${TELEMETRY_LIMITS.workspaceObservations})`,
        )
        .run().changes;
    return deleted;
  });
}
export function authenticateTelemetry(id: string, token: string) {
  const row = getDb().select().from(sources).where(eq(sources.id, id)).get();
  if (
    !row ||
    !row.tokenHash ||
    token.length > 200 ||
    !timingSafeEqual(Buffer.from(row.tokenHash), Buffer.from(digest(token)))
  )
    throw new HttpError(401, "Invalid ingestion credential");
  if (!row.config.enabled) throw new HttpError(403, "Telemetry source is disabled");
  return row;
}
export function ingestTelemetry(id: string, token: string, raw: unknown, now = Date.now()) {
  return getDb().transaction((tx) => {
    const source = authenticateTelemetry(id, token);
    let decoded: ReturnType<typeof decodeTelemetry>;
    try {
      decoded = decodeTelemetry(raw, source.config, now);
    } catch {
      throw new HttpError(400, "Invalid OTLP trace structure or batch limit exceeded");
    }
    const { counts } = decoded;
    pruneTelemetry(now, source.workspaceId);
    let checkedStorage = false;
    for (const item of decoded.observations) {
      if (
        tx
          .select({ id: observations.id })
          .from(observations)
          .where(
            and(
              eq(observations.sourceId, id),
              eq(observations.traceId, item.traceId),
              eq(observations.spanId, item.spanId),
            ),
          )
          .get()
      ) {
        counts.duplicates++;
        continue;
      }
      if (!checkedStorage) {
        assertStorage(source.workspaceId);
        checkedStorage = true;
      }
      tx.insert(observations)
        .values({
          ...item,
          id: newId(),
          sourceId: id,
          workspaceId: source.workspaceId,
          sourceRevision: source.revision,
        })
        .run();
      counts.accepted++;
    }
    counts.evicted = pruneTelemetry(now, source.workspaceId);
    tx.update(sources).set({ lastReceivedAt: now, lastIntake: counts }).where(eq(sources.id, id)).run();
    return counts;
  });
}
function readObservations(workspaceId: string, query: TelemetryQuery) {
  authorize(currentCaller(), workspaceId, "read");
  pruneTelemetry(Date.now(), workspaceId);
  return getDb()
    .select()
    .from(observations)
    .where(
      and(
        eq(observations.workspaceId, workspaceId),
        gte(observations.at, query.from),
        lt(observations.at, query.to),
      ),
    )
    .limit(TELEMETRY_LIMITS.workspaceObservations)
    .all();
}
export function getTelemetryMetrics(workspaceId: string, raw: z.input<typeof telemetryQuery>) {
  const query = telemetryQuery.parse(raw);
  return aggregateTelemetry(readObservations(workspaceId, query), query);
}
export function getTelemetryEndpoint(workspaceId: string, id: string, raw: z.input<typeof telemetryQuery>) {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new HttpError(400, "Invalid endpoint id");
  const query = telemetryQuery.parse(raw),
    result = telemetryEndpoint(readObservations(workspaceId, query), query, id);
  if (!result) throw new HttpError(404, "Endpoint not found in this time window");
  return result;
}
const worker = globalThis as typeof globalThis & {
  __postboxTelemetryRetention?: ReturnType<typeof setInterval>;
};
export function startTelemetryRetention() {
  if (worker.__postboxTelemetryRetention) return;
  const prune = () => {
    try {
      pruneTelemetry();
    } catch {
      console.error("[postbox] telemetry retention failed");
    }
  };
  prune();
  worker.__postboxTelemetryRetention = setInterval(prune, 60000);
  worker.__postboxTelemetryRetention.unref();
}
