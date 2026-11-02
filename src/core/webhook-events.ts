/** Event names are shared with the browser, so this file must not import Node modules. */
/** Events a webhook can subscribe to. New sources add names here and call `emitEvent`. */
export const WEBHOOK_EVENTS = [
  {
    type: "monitor.incident",
    description: "A monitor crossed its failure threshold and opened an incident.",
  },
  { type: "monitor.recovered", description: "A monitor recovered and closed its open incident." },
  { type: "run.passed", description: "A collection run finished and every request and test passed." },
  { type: "run.failed", description: "A collection run finished with a failed request or test." },
  { type: "run.cancelled", description: "A collection run was cancelled before it finished." },
  { type: "run.error", description: "A collection run stopped because of an internal error." },
  { type: "load.passed", description: "A load test finished and every threshold passed." },
  { type: "load.failed", description: "A load test finished with a failed threshold." },
  { type: "load.cancelled", description: "A load test was cancelled before it finished." },
  { type: "load.error", description: "A load test stopped because of an internal error." },
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENTS)[number]["type"] | "webhook.test";
export const SUBSCRIBABLE_EVENTS: readonly string[] = WEBHOOK_EVENTS.map((event) => event.type);
