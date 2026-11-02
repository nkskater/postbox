/**
 * Formats for chat and incident tools. An adapter turns the generic Postbox event into the body that service
 * expects. It runs at send time on the stored event, so credentials an adapter needs (a PagerDuty routing key) are
 * never part of a stored payload, a delivery record or an API response. Pure: no I/O.
 */
import type { WebhookEvent } from "./webhooks";

export const WEBHOOK_FORMATS = ["postbox", "slack", "discord", "teams", "pagerduty"] as const;
export type WebhookFormat = (typeof WEBHOOK_FORMATS)[number];

export const FORMAT_LABELS: Record<WebhookFormat, string> = {
  postbox: "Postbox JSON (signed)",
  slack: "Slack",
  discord: "Discord",
  teams: "Microsoft Teams",
  pagerduty: "PagerDuty",
};

/** Formats whose destination URL is itself a credential, so it must be kept in the secrets vault. */
export const URL_IS_CREDENTIAL: readonly WebhookFormat[] = ["slack", "discord", "teams"];

export const PAGERDUTY_URL = "https://events.pagerduty.com/v2/enqueue";

type Severity = "good" | "bad" | "warn" | "info";

export interface Summary {
  title: string;
  detail: string;
  severity: Severity;
  /** Identifies the thing an incident is about, so a pass can resolve the earlier failure. */
  key: string;
  /** Whether PagerDuty should open (trigger) or close (resolve) an incident. */
  incident: "trigger" | "resolve" | "none";
}

const text = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const seconds = (ms: unknown) => `${(num(ms) / 1000).toFixed(1)} s`;
const pct = (v: unknown) => `${(num(v) * 100).toFixed(1)}%`;

export function summarize(event: WebhookEvent): Summary {
  const d = (event.data ?? {}) as Record<string, unknown>;
  const name = text(d.name) || "Collection";
  const key = `${event.type.split(".")[0]}:${text(d.folderId) || event.workspaceId}`;
  switch (event.type) {
    case "run.passed":
      return {
        title: `Run passed: ${name}`,
        detail: `${num(d.totalRequests)} requests, ${num(d.passedTests)} tests passed in ${seconds(d.durationMs)}`,
        severity: "good",
        key,
        incident: "resolve",
      };
    case "run.failed":
      return {
        title: `Run failed: ${name}`,
        detail: `${num(d.failedRequests)} of ${num(d.totalRequests)} requests failed, ${num(d.failedTests)} tests failed (${seconds(d.durationMs)})`,
        severity: "bad",
        key,
        incident: "trigger",
      };
    case "run.cancelled":
      return {
        title: `Run cancelled: ${name}`,
        detail: "The run was stopped before it finished",
        severity: "warn",
        key,
        incident: "none",
      };
    case "run.error":
      return {
        title: `Run error: ${name}`,
        detail: "The run stopped because of an internal error",
        severity: "bad",
        key,
        incident: "trigger",
      };
    case "load.passed":
      return {
        title: `Load test passed: ${name}`,
        detail: `${num(d.requests)} requests at ${num(d.rps)}/s, p95 ${num(d.p95Ms)} ms, errors ${pct(d.errorRate)}, peak ${num(d.peakVus)} users`,
        severity: "good",
        key,
        incident: "resolve",
      };
    case "load.failed":
      return {
        title: `Load test failed: ${name}`,
        detail: `${num(d.thresholdsFailed)} threshold(s) failed. ${num(d.requests)} requests at ${num(d.rps)}/s, p95 ${num(d.p95Ms)} ms, errors ${pct(d.errorRate)}`,
        severity: "bad",
        key,
        incident: "trigger",
      };
    case "load.cancelled":
      return {
        title: `Load test cancelled: ${name}`,
        detail: "The test was stopped before it finished",
        severity: "warn",
        key,
        incident: "none",
      };
    case "load.error":
      return {
        title: `Load test error: ${name}`,
        detail: "The test stopped because of an internal error",
        severity: "bad",
        key,
        incident: "trigger",
      };
    case "webhook.test":
      return {
        title: "Test event from Postbox",
        detail: text(d.message) || "This webhook is working",
        severity: "info",
        key: "test",
        incident: "none",
      };
    default:
      return { title: event.type, detail: `Event ${event.id}`, severity: "info", key, incident: "none" };
  }
}

const COLOR: Record<Severity, { hex: string; int: number; emoji: string }> = {
  good: { hex: "2EB67D", int: 0x2eb67d, emoji: "✅" },
  bad: { hex: "E01E5A", int: 0xe01e5a, emoji: "🔴" },
  warn: { hex: "ECB22E", int: 0xecb22e, emoji: "⚠️" },
  info: { hex: "36C5F0", int: 0x36c5f0, emoji: "ℹ️" },
};

export interface Rendered {
  body: string;
  contentType: string;
  headers: [string, string][];
}

export interface AdapterContext {
  /** The PagerDuty Events API routing (integration) key. */
  routingKey?: string;
}

export class AdapterError extends Error {}

const json = (value: unknown): Rendered => ({
  body: JSON.stringify(value),
  contentType: "application/json",
  headers: [],
});

/** Body for a service, or the event itself for the Postbox format. Throws AdapterError when a credential is missing. */
export function renderAdapter(
  format: WebhookFormat,
  event: WebhookEvent,
  rawPayload: string,
  ctx: AdapterContext = {},
): Rendered {
  const s = summarize(event);
  const c = COLOR[s.severity];
  switch (format) {
    case "postbox":
      return { body: rawPayload, contentType: "application/json", headers: [] };
    case "slack":
      return json({
        text: `${c.emoji} ${s.title}: ${s.detail}`,
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: `${c.emoji} *${escapeSlack(s.title)}*\n${escapeSlack(s.detail)}` },
          },
          {
            type: "context",
            elements: [{ type: "mrkdwn", text: `Postbox · ${event.type} · ${event.createdAt}` }],
          },
        ],
      });
    case "discord":
      return json({
        username: "Postbox",
        content: `${c.emoji} **${s.title}**`.slice(0, 2000),
        embeds: [
          {
            title: s.title.slice(0, 256),
            description: s.detail.slice(0, 4000),
            color: c.int,
            timestamp: event.createdAt,
            footer: { text: event.type },
          },
        ],
        allowed_mentions: { parse: [] },
      });
    case "teams":
      return json({
        "@type": "MessageCard",
        "@context": "https://schema.org/extensions",
        summary: s.title,
        themeColor: c.hex,
        title: s.title,
        text: s.detail,
        sections: [
          {
            facts: [
              { name: "Event", value: event.type },
              { name: "Time", value: event.createdAt },
            ],
          },
        ],
      });
    case "pagerduty": {
      if (!ctx.routingKey) throw new AdapterError("PagerDuty needs a routing key from the secrets vault");
      if (s.incident === "none" && event.type !== "webhook.test")
        return json({
          routing_key: ctx.routingKey,
          event_action: "trigger",
          payload: { summary: `${s.title}: ${s.detail}`.slice(0, 1024), source: "postbox", severity: "info" },
          dedup_key: `postbox:${event.id}`,
        });
      return json({
        routing_key: ctx.routingKey,
        event_action: s.incident === "resolve" ? "resolve" : "trigger",
        dedup_key: `postbox:${s.key}`,
        payload: {
          summary: `${s.title}: ${s.detail}`.slice(0, 1024),
          source: "postbox",
          severity: s.severity === "bad" ? "error" : s.severity === "warn" ? "warning" : "info",
          timestamp: event.createdAt,
          custom_details: { event: event.type, eventId: event.id, workspaceId: event.workspaceId },
        },
      });
    }
  }
}

const escapeSlack = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Headers a custom header may not set: they belong to the transport or to Postbox's own signature. */
const RESERVED = new Set([
  "host",
  "content-length",
  "content-type",
  "transfer-encoding",
  "connection",
  "upgrade",
  "te",
  "trailer",
  "keep-alive",
  "proxy-authorization",
  "proxy-authenticate",
  "user-agent",
]);

export interface CustomHeader {
  name: string;
  value: string;
}

/** Problems with a custom header list, or null when it is acceptable. */
export function checkCustomHeaders(headers: readonly CustomHeader[]): string | null {
  if (headers.length > 10) return "At most 10 custom headers are allowed";
  const seen = new Set<string>();
  for (const { name, value } of headers) {
    const lower = name.toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/.test(name)) return `"${name}" is not a valid header name`;
    if (RESERVED.has(lower) || lower.startsWith("postbox-"))
      return `The ${name} header is set by Postbox and cannot be customised`;
    if (seen.has(lower)) return `The ${name} header is listed twice`;
    seen.add(lower);
    if (/[\r\n\0]/.test(value) || value.length > 4096) return `The value of ${name} is not valid`;
  }
  return null;
}
