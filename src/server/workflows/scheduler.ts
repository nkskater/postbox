import { Cron } from "croner";
import { eq } from "drizzle-orm";
import { getDb, schema } from "../db";
import { deploymentRow, triggerDeployment, validWorkflowCron } from "./deployments";
import { initializeWorkflowRuns } from "./runner";
import { flowState } from "./state";
const globalScheduler = globalThis as typeof globalThis & {
  __postboxFlowScheduler?: { started: boolean; jobs: Map<string, Cron> };
};
const state = (globalScheduler.__postboxFlowScheduler ??= { started: false, jobs: new Map() });
export function syncWorkflowSchedules() {
  if (!state.started) return;
  for (const job of state.jobs.values()) job.stop();
  state.jobs.clear();
  for (const deployment of getDb()
    .select()
    .from(schema.workflowDeployments)
    .where(eq(schema.workflowDeployments.enabled, true))
    .all()) {
    if (!deployment.cron) continue;
    if (!validWorkflowCron(deployment.cron)) {
      getDb()
        .update(schema.workflowDeployments)
        .set({ lastError: "Invalid workflow schedule" })
        .where(eq(schema.workflowDeployments.id, deployment.id))
        .run();
      continue;
    }
    const job = new Cron(deployment.cron, { timezone: "UTC", unref: true }, () => {
      try {
        const live = deploymentRow(deployment.id);
        triggerDeployment(live, "schedule", live.input, `schedule:${Math.floor(Date.now() / 60000)}`);
      } catch (error) {
        getDb()
          .update(schema.workflowDeployments)
          .set({
            lastError: (error instanceof Error ? error.message : "Scheduled workflow failed").slice(0, 500),
            lastTriggeredAt: Date.now(),
          })
          .where(eq(schema.workflowDeployments.id, deployment.id))
          .run();
      }
    });
    state.jobs.set(deployment.id, job);
  }
}
export function startWorkflowScheduler() {
  if (state.started) return;
  initializeWorkflowRuns();
  state.started = true;
  flowState.refreshSchedules = syncWorkflowSchedules;
  syncWorkflowSchedules();
}
export function stopWorkflowScheduler() {
  for (const job of state.jobs.values()) job.stop();
  state.jobs.clear();
  state.started = false;
  flowState.refreshSchedules = undefined;
}
