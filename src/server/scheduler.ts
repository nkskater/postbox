import { Cron } from "croner";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { DEFAULT_RUN_OPTIONS } from "@/core/types";
import { getDb, schema } from "./db";
import type { ScheduleRow } from "./db/schema";
import { newId } from "./defaults";
import { HttpError, notFound } from "./http";
import * as repo from "./repo";
import { startRun } from "./runs";
import { actorId, authorize } from "./authorize";
import { withCaller } from "./access-context";
import { countUsers, getUser } from "./users";
import type { Caller } from "./caller";

const { schedules, runs } = schema;
interface SchedulerState {
  started: boolean;
  jobs: Map<string, Cron>;
  active: Map<string, AbortController>;
}
const globals = globalThis as typeof globalThis & { __postboxScheduler?: SchedulerState };
const state = (globals.__postboxScheduler ??= { started: false, jobs: new Map(), active: new Map() });

/** All schedule expressions use UTC, including optional seconds/year fields. */
export function validCron(expression: string): boolean {
  if (![5, 6, 7].includes(expression.trim().split(/\s+/).length)) return false;
  let job: Cron | undefined;
  try {
    job = new Cron(expression, { paused: true, timezone: "UTC" });
    return job.nextRun() !== null;
  } catch {
    return false;
  } finally {
    job?.stop();
  }
}

const runOptions = z
  .object({
    iterations: z.number().int().min(1).max(100000).optional(),
    delayMs: z.number().int().min(0).max(600000).optional(),
    stopOnFailure: z.boolean().optional(),
    timeoutMs: z
      .number()
      .int()
      .min(100)
      .max(2147483647)
      .nullable()
      .transform((value) => value ?? undefined)
      .optional(),
    verifySsl: z.boolean().optional(),
    persistVariables: z.boolean().optional(),
  })
  .strict();

export const scheduleInput = z
  .object({
    workspaceId: z.string().min(1),
    folderId: z.string().min(1),
    name: z.string().trim().min(1).max(200),
    environmentId: z.string().min(1).nullable().optional(),
    cron: z.string().trim().max(200).refine(validCron, "Invalid cron expression or no future occurrence"),
    options: runOptions.optional(),
    enabled: z.boolean().optional(),
  })
  .strict();
export const schedulePatch = scheduleInput.omit({ workspaceId: true }).partial();

function row(id: string): ScheduleRow {
  const found = getDb().select().from(schedules).where(eq(schedules.id, id)).get();
  if (!found) throw notFound("Schedule");
  return found;
}

function scheduleCaller(schedule: ScheduleRow): Caller {
  if (!schedule.createdBy) {
    if (countUsers()) throw new HttpError(403, "Schedule has no account owner");
    return { kind: "env" };
  }
  const user = getUser(schedule.createdBy);
  if (!user || user.disabled) throw new HttpError(403, "Schedule owner is unavailable");
  const caller: Caller = { kind: "user", user, via: "session" };
  authorize(caller, schedule.workspaceId, "run");
  return caller;
}

function validateReferences(schedule: Pick<ScheduleRow, "workspaceId" | "folderId" | "environmentId">) {
  if (!repo.getWorkspace(schedule.workspaceId)) throw notFound("Workspace");
  const folder = repo.getFolder(schedule.folderId);
  if (!folder || folder.workspaceId !== schedule.workspaceId) {
    throw new HttpError(400, "Folder must belong to the schedule's workspace");
  }
  if (schedule.environmentId) {
    const environment = repo.getEnvironment(schedule.environmentId);
    if (!environment || environment.workspaceId !== schedule.workspaceId) {
      throw new HttpError(400, "Environment must belong to the schedule's workspace");
    }
  }
}

function unregister(id: string) {
  state.jobs.get(id)?.stop();
  state.jobs.delete(id);
}

function register(schedule: ScheduleRow) {
  unregister(schedule.id);
  if (!schedule.enabled) return;
  if (!validCron(schedule.cron)) throw new HttpError(400, "Invalid cron expression");
  validateReferences(schedule);
  scheduleCaller(schedule);
  state.jobs.set(
    schedule.id,
    new Cron(schedule.cron, { timezone: "UTC", unref: true }, () => {
      void runSchedule(schedule.id).catch((error: unknown) => {
        if (!(error instanceof HttpError && error.status === 409)) {
          console.error(`[postbox] schedule ${schedule.id}: ${(error as Error).message}`);
        }
      });
    }),
  );
}

/** Idempotent across startup, route bundles and development reloads in one process. */
export function startScheduler() {
  if (state.started) return;
  const enabled = getDb().select().from(schedules).where(eq(schedules.enabled, true)).all();
  state.started = true;
  for (const schedule of enabled) {
    try {
      register(schedule);
    } catch (error) {
      // A deleted folder/environment or malformed legacy row must not prevent startup.
      getDb()
        .update(schedules)
        .set({ enabled: false, updatedAt: Date.now() })
        .where(eq(schedules.id, schedule.id))
        .run();
      console.error(`[postbox] disabled schedule ${schedule.id}: ${(error as Error).message}`);
    }
  }
}

/** Stop future triggers; already running collections are allowed to finish. */
export function stopScheduler() {
  for (const id of state.jobs.keys()) unregister(id);
  state.started = false;
}

function describe(schedule: ScheduleRow) {
  const last = schedule.lastRunId
    ? getDb().select({ status: runs.status }).from(runs).where(eq(runs.id, schedule.lastRunId)).get()
    : undefined;
  const running = state.active.has(schedule.id);
  return {
    ...schedule,
    running,
    lastRunStatus: last?.status === "running" && !running ? "error" : (last?.status ?? null),
    nextRunAt: state.jobs.get(schedule.id)?.nextRun()?.getTime() ?? null,
  };
}

export function listSchedules(workspaceId: string, folderId?: string | null) {
  startScheduler();
  return getDb()
    .select()
    .from(schedules)
    .where(
      folderId
        ? and(eq(schedules.workspaceId, workspaceId), eq(schedules.folderId, folderId))
        : eq(schedules.workspaceId, workspaceId),
    )
    .orderBy(asc(schedules.createdAt))
    .all()
    .map(describe);
}

export function createSchedule(input: z.input<typeof scheduleInput>) {
  const parsed = scheduleInput.parse(input);
  const schedule: ScheduleRow = {
    ...parsed,
    id: newId(),
    createdBy: actorId(),
    environmentId: parsed.environmentId ?? null,
    options: { ...DEFAULT_RUN_OPTIONS, ...parsed.options },
    enabled: parsed.enabled ?? true,
    lastRunAt: null,
    lastRunId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  validateReferences(schedule);
  startScheduler();
  getDb().insert(schedules).values(schedule).run();
  register(schedule);
  return describe(schedule);
}

export function updateSchedule(id: string, input: z.input<typeof schedulePatch>) {
  const patch = schedulePatch.parse(input);
  const existing = row(id);
  const schedule = {
    ...existing,
    ...patch,
    options: { ...existing.options, ...patch.options },
    updatedAt: Date.now(),
  };
  validateReferences(schedule);
  startScheduler();
  getDb().update(schedules).set(schedule).where(eq(schedules.id, id)).run();
  register(schedule);
  return describe(schedule);
}

export function deleteSchedule(id: string) {
  row(id);
  unregister(id);
  getDb().delete(schedules).where(eq(schedules.id, id)).run();
}

/** Return once a run has started; keep the overlap lock until it fully finishes. */
export async function runSchedule(id: string): Promise<{ runId: string }> {
  let schedule: ScheduleRow;
  try {
    schedule = row(id);
  } catch (error) {
    unregister(id);
    throw error;
  }
  if (state.active.has(id)) throw new HttpError(409, "This schedule is already running");
  try {
    validateReferences(schedule);
    scheduleCaller(schedule);
  } catch (error) {
    unregister(id);
    getDb()
      .update(schedules)
      .set({ enabled: false, updatedAt: Date.now() })
      .where(eq(schedules.id, id))
      .run();
    throw error;
  }
  const controller = new AbortController();
  state.active.set(id, controller);
  const monitor = setInterval(() => {
    try {
      scheduleCaller(schedule);
    } catch {
      controller.abort();
      unregister(id);
      getDb().update(schedules).set({ enabled: false }).where(eq(schedules.id, id)).run();
    }
  }, 1000);
  monitor.unref();
  return new Promise((resolve, reject) => {
    void withCaller(scheduleCaller(schedule), () =>
      startRun({
        workspaceId: schedule.workspaceId,
        folderId: schedule.folderId,
        environmentId: schedule.environmentId,
        options: schedule.options,
        source: "schedule",
        retainResults: false,
        signal: controller.signal,
        onEvent: (event) => {
          if (event.type !== "start") return;
          getDb()
            .update(schedules)
            .set({ lastRunId: event.runId, lastRunAt: event.startedAt })
            .where(eq(schedules.id, id))
            .run();
          resolve({ runId: event.runId });
        },
      }),
    )
      .catch((error: unknown) => {
        reject(error);
        console.error(`[postbox] scheduled run ${id} failed: ${(error as Error).message}`);
      })
      .finally(() => {
        clearInterval(monitor);
        state.active.delete(id);
      });
  });
}
