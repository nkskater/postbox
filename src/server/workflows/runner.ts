import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { executeFlow, type FlowReference } from "@/core/workflows/engine";
import {
  jsonBudget,
  MAX_VALUE_BYTES,
  referenceKey,
  type FlowActor,
  type FlowUnit,
  type Json,
} from "@/core/workflows/model";
import {
  authCredentialValues,
  credentialRedactionValues,
  redactSensitiveFields,
  sensitiveFieldValues,
} from "@/core/retention";
import { redactStoredValue } from "@/core/variables/resolver";
import type { AuthConfig } from "@/core/types";
import { getDb, schema } from "../db";
import { withCaller, currentCaller } from "../access-context";
import { authorize } from "../authorize";
import { loadScopes, runSingleRequest } from "../context";
import { newId } from "../defaults";
import { HttpError, notFound } from "../errors";
import * as repo from "../repo";
import { reserveRun } from "../runs";
import { assertStorage, reserveUsage } from "../usage";
import { captureActor, resolveActor } from "./actor";
import { compileBundle, openArtifact } from "./artifacts";
import { checkedGraph, jsonInput, row } from "./repo";
import { cancelActive, flowState, type ActiveFlow } from "./state";
const table = schema.workflowRuns;
export interface FixtureResponse {
  status?: number;
  data?: Json;
  headers?: Record<string, string>;
  testsPassed?: boolean;
}
export interface StartFlowInput {
  workflowId: string;
  version?: number;
  graph?: unknown;
  environmentId?: string | null;
  input: Json;
  source: "fixture" | "manual" | "schedule" | "webhook";
  fixtures?: Record<string, FixtureResponse>;
  actor?: FlowActor;
  deploymentId?: string | null;
  idempotencyKey?: string | null;
}
export function initializeWorkflowRuns() {
  if (flowState.initialized) return;
  getDb()
    .update(table)
    .set({
      status: "interrupted",
      error: "Server restarted before completion; side effects may already have occurred",
      finishedAt: Date.now(),
    })
    .where(inArray(table.status, ["queued", "running"]))
    .run();
  flowState.initialized = true;
}
export function flowRunRow(id: string) {
  const run = getDb().select().from(table).where(eq(table.id, id)).get();
  if (!run) throw notFound("Workflow run");
  return run;
}
export function getFlowRun(id: string) {
  const run = flowRunRow(id);
  authorize(currentCaller(), run.workspaceId, "read");
  return run;
}
export function listFlowRuns(workflowId: string) {
  const workflow = row(workflowId);
  authorize(currentCaller(), workflow.workspaceId, "read");
  return getDb()
    .select({
      id: table.id,
      workflowId: table.workflowId,
      version: table.version,
      sourceRevision: table.sourceRevision,
      contentHash: table.contentHash,
      deploymentId: table.deploymentId,
      source: table.source,
      status: table.status,
      error: table.error,
      steps: table.steps,
      durationMs: table.durationMs,
      traceOmitted: table.traceOmitted,
      createdAt: table.createdAt,
      startedAt: table.startedAt,
      finishedAt: table.finishedAt,
    })
    .from(table)
    .where(eq(table.workflowId, workflowId))
    .orderBy(desc(table.createdAt))
    .limit(100)
    .all();
}
export function cancelFlowRun(id: string) {
  const run = flowRunRow(id);
  authorize(currentCaller(), run.workspaceId, "run");
  return { cancelled: cancelActive(id) };
}
function canonical(value: Json): Json {
  return Array.isArray(value)
    ? value.map(canonical)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
}
function fingerprint(value: Json) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
function refreshCachedAuth(snapshot: AuthConfig, current: AuthConfig): AuthConfig {
  if (snapshot.type !== "oauth2" || current.type !== "oauth2") return snapshot;
  const omitCache = (auth: typeof snapshot) => {
    const {
      accessToken: _access,
      refreshToken: _refresh,
      expiresAt: _expires,
      tokenContext: _context,
      ...settings
    } = auth.oauth2;
    return settings;
  };
  if (JSON.stringify(omitCache(snapshot)) !== JSON.stringify(omitCache(current))) return snapshot;
  return {
    ...snapshot,
    oauth2: {
      ...snapshot.oauth2,
      accessToken: current.oauth2.accessToken,
      refreshToken: current.oauth2.refreshToken,
      expiresAt: current.oauth2.expiresAt,
      tokenContext: current.oauth2.tokenContext,
    },
  };
}
function boundedFixture(value: FixtureResponse): FixtureResponse {
  jsonBudget(value);
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !["status", "data", "headers", "testsPassed"].includes(key))
  )
    throw new HttpError(400, "Invalid request fixture");
  if (
    value.status !== undefined &&
    (!Number.isInteger(value.status) || value.status < 100 || value.status > 599)
  )
    throw new HttpError(400, "Fixture status must be from 100 to 599");
  if (
    value.headers !== undefined &&
    (value.headers === null ||
      typeof value.headers !== "object" ||
      Array.isArray(value.headers) ||
      Object.values(value.headers).some((v) => typeof v !== "string"))
  )
    throw new HttpError(400, "Fixture headers must contain text values");
  if (value.testsPassed !== undefined && typeof value.testsPassed !== "boolean")
    throw new HttpError(400, "Invalid fixture test outcome");
  return value;
}
function trimHistory(workspaceId: string) {
  const old = getDb()
    .select({ id: table.id })
    .from(table)
    .where(
      and(
        eq(table.workspaceId, workspaceId),
        inArray(table.status, ["passed", "failed", "cancelled", "interrupted"]),
      ),
    )
    .orderBy(desc(table.createdAt))
    .limit(1000)
    .offset(1000)
    .all();
  for (const item of old) getDb().delete(table).where(eq(table.id, item.id)).run();
}
export function startFlowRun(input: StartFlowInput) {
  initializeWorkflowRuns();
  const workflow = row(input.workflowId),
    actor = input.actor ?? captureActor(),
    fixtureMode = input.source === "fixture";
  const action = fixtureMode ? "read" : "run",
    caller = resolveActor(actor, workflow.workspaceId, action);
  withCaller(caller, () => authorize(caller, workflow.workspaceId, action));
  assertStorage(workflow.workspaceId);
  const data = jsonInput(input.input),
    environmentId = input.environmentId ?? null;
  if (environmentId) {
    const environment = repo.getEnvironment(environmentId);
    if (!environment || environment.workspaceId !== workflow.workspaceId)
      throw new HttpError(400, "Environment is unavailable in this workspace");
  }
  const bundle =
    input.version === undefined
      ? compileBundle(
          workflow.workspaceId,
          input.graph === undefined ? workflow.graph : checkedGraph(input.graph),
        )
      : openArtifact(workflow.workspaceId, workflow.id, input.version);
  const contentHash = createHash("sha256").update(JSON.stringify(bundle)).digest("hex");
  const fixtures = input.fixtures ?? {};
  if (fixtureMode) {
    jsonInput(fixtures);
    for (const fixture of Object.values(fixtures)) boundedFixture(fixture);
  }
  const inputHash = fingerprint(data),
    idempotencyHash = input.idempotencyKey
      ? createHash("sha256").update(input.idempotencyKey).digest("hex")
      : null;
  if (idempotencyHash && input.deploymentId) {
    const previous = getDb()
      .select()
      .from(table)
      .where(and(eq(table.deploymentId, input.deploymentId), eq(table.idempotencyHash, idempotencyHash)))
      .get();
    if (previous) {
      if (previous.inputHash !== inputHash)
        throw new HttpError(409, "Idempotency key was already used with different input");
      return { runId: previous.id, status: previous.status, duplicate: true, position: 0 };
    }
  }
  const secrets = new Set<string>();
  const collect = (values: string[]) => {
    for (const value of credentialRedactionValues(values)) secrets.add(value);
  };
  collect(sensitiveFieldValues(data));
  const units = [bundle.root, ...Object.values(bundle.subflows)];
  for (const unit of units)
    for (const snapshot of Object.values(unit.requests)) {
      collect([
        ...authCredentialValues(snapshot.request.auth),
        ...sensitiveFieldValues(snapshot.request),
        ...snapshot.ancestors.flatMap((folder) => authCredentialValues(folder.auth)),
      ]);
      if (!fixtureMode)
        withCaller(caller, () =>
          collect(loadScopes(workflow.workspaceId, environmentId, snapshot.ancestors[0]?.id ?? null).secrets),
        );
    }
  const redact = <T>(value: T): T => redactStoredValue(redactSensitiveFields(value), secrets);
  const ticket = reserveRun(),
    id = newId(),
    controller = new AbortController(),
    createdAt = Date.now();
  try {
    if (!fixtureMode)
      withCaller(caller, () =>
        reserveUsage({
          workspaceId: workflow.workspaceId,
          metric: "runs",
          key: `workflow:${id}`,
          enforce: true,
        }),
      );
    getDb()
      .insert(table)
      .values({
        id,
        workspaceId: workflow.workspaceId,
        workflowId: workflow.id,
        version: input.version ?? null,
        sourceRevision: input.version === undefined ? workflow.revision : null,
        contentHash,
        deploymentId: input.deploymentId ?? null,
        actor,
        source: input.source,
        status: ticket.position ? "queued" : "running",
        input: sql`${JSON.stringify(redact(data))}`,
        output: null,
        trace: [],
        error: null,
        steps: 0,
        traceOmitted: 0,
        durationMs: 0,
        idempotencyHash,
        inputHash,
        createdAt,
        startedAt: null,
        finishedAt: null,
      })
      .run();
  } catch (error) {
    ticket.cancel();
    throw error;
  }
  const active: ActiveFlow = {
    controller,
    ticket,
    queued: ticket.position > 0,
    queueExpired: false,
    workspaceId: workflow.workspaceId,
    workflowId: workflow.id,
    deploymentId: input.deploymentId ?? null,
    completion: Promise.resolve(),
  };
  flowState.active.set(id, active);
  const queueTimer = setTimeout(() => {
    if (active.queued) {
      active.queueExpired = true;
      controller.abort(new Error("Workflow queue wait limit exceeded"));
      ticket.cancel();
    }
  }, 120000);
  queueTimer.unref?.();
  const unitFor = (reference: FlowReference | null): FlowUnit =>
    !reference || (reference.workflowId === workflow.id && reference.version === input.version)
      ? bundle.root
      : bundle.subflows[referenceKey(reference.workflowId, reference.version)];
  let requestCount = 0;
  const worker = async () => {
    let startedAt: number | undefined;
    try {
      await ticket.ready;
      clearTimeout(queueTimer);
      active.queued = false;
      controller.signal.throwIfAborted();
      resolveActor(actor, workflow.workspaceId, action);
      startedAt = Date.now();
      getDb().update(table).set({ status: "running", startedAt }).where(eq(table.id, id)).run();
      let lastWrite = 0;
      const result = await executeFlow(bundle.root.graph, data, {
        signal: controller.signal,
        rootReference:
          input.version === undefined ? undefined : { workflowId: workflow.id, version: input.version },
        beforeStep: () => {
          resolveActor(actor, workflow.workspaceId, action);
          if (input.deploymentId) {
            const deployment = getDb()
              .select()
              .from(schema.workflowDeployments)
              .where(eq(schema.workflowDeployments.id, input.deploymentId))
              .get();
            if (!deployment?.enabled) throw new Error("Workflow deployment was disabled");
          }
          if (environmentId && !repo.getEnvironment(environmentId))
            throw new Error("Workflow environment was deleted");
        },
        redact: (value) => redact(value),
        onTrace: (trace) => {
          const now = Date.now();
          if (now - lastWrite < 500) return;
          lastWrite = now;
          getDb()
            .update(table)
            .set({ trace: redact(trace), steps: trace.at(-1)?.step ?? 0 })
            .where(eq(table.id, id))
            .run();
        },
        subflow: async (node) => {
          const unit = bundle.subflows[referenceKey(node.workflowId, node.version)];
          if (!unit) throw new Error("Pinned subflow snapshot is missing");
          return unit.graph;
        },
        request: async (node, bindings, signal, reference) => {
          if (fixtureMode) {
            if (!Object.hasOwn(fixtures, node.requestId))
              throw new Error(`Provide a fixture for request ${node.requestId}`);
            const fixture = fixtures[node.requestId],
              status = fixture.status ?? 200;
            return {
              ok:
                (!node.failOnHttpError || status < 400) &&
                (!node.failOnTests || fixture.testsPassed !== false),
              value: { status, data: fixture.data ?? null, headers: fixture.headers ?? {}, elapsedMs: 0 },
              error: status >= 400 ? `HTTP ${status}` : "Fixture tests failed",
            };
          }
          const live = resolveActor(actor, workflow.workspaceId, "run"),
            unit = unitFor(reference),
            snapshot = unit?.requests[node.requestId];
          if (!snapshot) throw new Error("Pinned request snapshot is missing");
          const current = repo.requireRequestIn(workflow.workspaceId, node.requestId),
            request = structuredClone(snapshot.request);
          request.auth = refreshCachedAuth(request.auth, current.auth);
          const ancestors = snapshot.ancestors.map((folder) => ({
            ...folder,
            auth: refreshCachedAuth(folder.auth, repo.requireFolderIn(workflow.workspaceId, folder.id).auth),
          }));
          const response = await withCaller(live, () =>
            runSingleRequest({
              workspaceId: workflow.workspaceId,
              environmentId,
              request,
              requestId: node.requestId,
              folderId: snapshot.folderId,
              frozenAncestors: ancestors,
              flowBindings: bindings,
              maxResponseBytes: MAX_VALUE_BYTES,
              persistVariables: bundle.root.graph.persistVariables,
              collectSecrets: collect,
              signal,
              idempotencyKey: `workflow:${id}:${++requestCount}`,
            }),
          );
          if (response.error || !response.response)
            return { ok: false, value: null, error: response.error ?? "Request produced no HTTP response" };
          if (response.response.truncated)
            return { ok: false, value: null, error: "Response exceeds the workflow data limit" };
          let data: Json = response.response.bodyText;
          try {
            data = JSON.parse(data);
          } catch {}
          const value: Json = {
            status: response.response.status,
            headers: Object.fromEntries(response.response.headers),
            data,
            elapsedMs: Math.round(response.response.timings.total),
          };
          jsonBudget(value);
          const passed =
            (!node.failOnHttpError || response.response.status < 400) &&
            (!node.failOnTests ||
              (!response.scriptErrors.length && response.tests.every((test) => test.passed)));
          return {
            ok: passed,
            value,
            error:
              response.response.status >= 400 ? `HTTP ${response.response.status}` : "Request tests failed",
          };
        },
      });
      getDb()
        .update(table)
        .set({
          status: result.status,
          input: sql`${JSON.stringify(redact(data))}`,
          output: redact(result.output),
          trace: redact(result.trace),
          error: result.error ? redact(result.error) : null,
          steps: result.steps,
          traceOmitted: result.traceOmitted,
          durationMs: result.durationMs,
          finishedAt: Date.now(),
        })
        .where(eq(table.id, id))
        .run();
    } catch (error) {
      const cancelled = controller.signal.aborted && !active.queueExpired;
      const message = active.queueExpired
        ? "Workflow queue wait limit exceeded"
        : cancelled
          ? "Workflow cancelled"
          : error instanceof Error
            ? error.message
            : "Workflow failed";
      getDb()
        .update(table)
        .set({
          status: cancelled ? "cancelled" : "failed",
          error: redact(message).slice(0, 1000),
          finishedAt: Date.now(),
          durationMs: startedAt ? Date.now() - startedAt : 0,
        })
        .where(eq(table.id, id))
        .run();
    } finally {
      clearTimeout(queueTimer);
      ticket.release();
      flowState.active.delete(id);
      try {
        if (!fixtureMode && startedAt)
          withCaller(caller, () =>
            reserveUsage({
              workspaceId: workflow.workspaceId,
              metric: "run_ms",
              amount: Date.now() - startedAt!,
              key: `workflow_ms:${id}`,
            }),
          );
        trimHistory(workflow.workspaceId);
      } catch {
        /* Cleanup and reporting cannot replace an execution outcome. */
      }
    }
  };
  active.completion = worker();
  active.completion.catch(() => undefined);
  return {
    runId: id,
    status: ticket.position ? "queued" : "running",
    position: ticket.position,
    duplicate: false,
  };
}
export async function waitForFlowRun(id: string, timeoutMs = 25000) {
  const active = flowState.active.get(id);
  if (!active) return flowRunRow(id);
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    active.completion,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
    }),
  ]);
  if (timer) clearTimeout(timer);
  return flowRunRow(id);
}
