/** Event names are shared with the browser, so this file must not import Node modules. */
/** Events a webhook can subscribe to. New sources add names here and call `emitEvent`. */
export const WEBHOOK_EVENTS = [
  { type: "run.passed", description: "A collection run finished and every request and test passed." },
  { type: "run.failed", description: "A collection run finished with a failed request or test." },
  { type: "run.cancelled", description: "A collection run was cancelled before it finished." },
  { type: "run.error", description: "A collection run stopped because of an internal error." },
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENTS)[number]["type"] | "webhook.test";
export const SUBSCRIBABLE_EVENTS: readonly string[] = WEBHOOK_EVENTS.map((event) => event.type);
