export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NEXT_PHASE !== "phase-production-build") {
    const { startScheduler } = await import("./server/scheduler");
    startScheduler();
    const { startWebhookWorker } = await import("./server/webhooks");
    startWebhookWorker();
  }
}
