import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { planRepro, reproMapping } from "@/core/telemetry/repro";
import { getDb, schema } from "./db";
import { authorize } from "./authorize";
import { currentCaller } from "./access-context";
import { HttpError } from "./errors";
import { getEnvironment } from "./repo";
import { pruneTelemetry } from "./telemetry";

const { telemetryObservations: observations } = schema;

export const telemetryReproInput = z
  .object({
    workspaceId: z.string().min(1).max(200),
    observationId: z.string().min(1).max(200),
    mapping: reproMapping,
  })
  .strict();

/** Reads one retained failed observation in a workspace the caller can read. */
export function getTelemetryFailure(workspaceId: string, observationId: string) {
  authorize(currentCaller(), workspaceId, "read");
  pruneTelemetry(Date.now(), workspaceId);
  const row = getDb()
    .select()
    .from(observations)
    .where(and(eq(observations.id, observationId), eq(observations.workspaceId, workspaceId)))
    .get();
  if (!row || !row.error) throw new HttpError(404, "Failed observation not found");
  const { workspaceId: _workspace, ...data } = row;
  return data;
}

/**
 * Plans a reproduction draft for a retained failure. Read-only: nothing is stored and no
 * request is sent; the caller opens the returned draft and replays it explicitly.
 */
export function planTelemetryRepro(raw: z.input<typeof telemetryReproInput>) {
  const input = telemetryReproInput.parse(raw),
    failure = getTelemetryFailure(input.workspaceId, input.observationId);
  let environmentVariables = input.mapping.environmentVariables;
  if (input.mapping.environmentId) {
    const environment = getEnvironment(input.mapping.environmentId);
    if (!environment || environment.workspaceId !== input.workspaceId)
      throw new HttpError(404, "Environment not found");
    environmentVariables = environment.variables.filter((v) => v.enabled).map((v) => v.key);
  }
  return planRepro(failure, { ...input.mapping, environmentVariables });
}
