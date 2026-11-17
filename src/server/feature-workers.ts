import { disabledFeatures } from "./features";

/**
 * Start the background workers of every feature area that is switched on. Called at startup and
 * after the Features settings change, so switching an area back on needs no restart. Each start
 * function is idempotent. A worker of an area switched off at runtime keeps its timer but does no
 * work (each pass checks the switch); the workflow scheduler also drops its cron jobs.
 */
export async function startFeatureWorkers() {
  const off = disabledFeatures();
  const workflows = await import("./workflows/scheduler");
  if (off.has("workflows")) workflows.stopWorkflowScheduler();
  else workflows.startWorkflowScheduler();
  if (!off.has("telemetry")) (await import("./telemetry")).startTelemetryRetention();
  if (!off.has("webhooks")) (await import("./webhooks")).startWebhookWorker();
  if (!off.has("monitors")) (await import("./monitor-email")).startMonitorEmailWorker();
}
