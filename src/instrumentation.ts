export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Before the first request: login throttling keys on the real client address.
    const { installClientAddressHook } = await import("./server/client-address");
    installClientAddressHook();
  }
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NEXT_PHASE !== "phase-production-build") {
    const { startScheduler } = await import("./server/scheduler");
    startScheduler();
    const { startTelemetryRetention } = await import("./server/telemetry");
    startTelemetryRetention();
    const { startWebhookWorker } = await import("./server/webhooks");
    startWebhookWorker();
    const { startMonitorEmailWorker } = await import("./server/monitor-email");
    startMonitorEmailWorker();
  }
}
