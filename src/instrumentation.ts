export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Before the first request: login throttling keys on the real client address.
    const { installClientAddressHook } = await import("./server/client-address");
    installClientAddressHook();
  }
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NEXT_PHASE !== "phase-production-build") {
    const { startScheduler } = await import("./server/scheduler");
    startScheduler();
    // Workflows, telemetry retention, webhook delivery and monitor email belong to optional
    // feature areas and start only when their area is switched on (Settings → Features).
    const { startFeatureWorkers } = await import("./server/feature-workers");
    await startFeatureWorkers();
  }
}
