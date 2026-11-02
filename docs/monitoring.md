# API monitors

Open **Monitors** in the sidebar to create a scheduled collection/folder check.
Choose the collection and environment, a UTC cron expression, and thresholds.
Saved monitors use the existing collection runner, scheduler, admission queue,
variable/vault resolution and outbound network policy. Monitoring never changes
saved environment variables. Each check runs one iteration and observes every
selected collection request unless the whole-check deadline is reached.

The dashboard refreshes every three seconds. It shows retained check history,
request p95 latency, observed HTTP availability, assertion pass rate, incidents,
recovery times and email delivery status. Choose 24 hours, 7, 30 or 90 days.
Summary cards cover the selected retained range; the chart/table show its latest
500 checks. Select a point or row to inspect threshold reasons and the run ID.
Availability describes observed requests, not a guarantee about time between
checks. The chart shows per-check p95, not a percentile of the full history.

## Thresholds and incidents

- **Minimum HTTP availability**: percentage of non-skipped requests with a
  response status from 200 through 399. Missing responses/timeouts count as
  unavailable. Default: 100%.
- **Maximum p95 latency**: 95th percentile of recorded request response times,
  in milliseconds. Blank disables this threshold. Missing latency fails an
  enabled latency threshold.
- **Minimum assertions passing**: percentage of executed, non-skipped `pm.test`
  results that passed. Blank disables it. When enabled, no assertions or script
  errors fail the check; skipped tests never count as passing assertions.
- **Consecutive failures/passes**: the number of failed checks required to open
  an incident and passed checks required to recover. Both default to one.
- **Request timeout / whole-check deadline**: bound individual requests and the
  admitted check. Queue wait does not consume the whole-check deadline. A check
  deadline is a failure; ordinary cancellation is recorded as skipped.

Repeated failures update the same incident without sending repeated incident
notifications. Recovery closes that incident only after the configured passing
streak. A later failure starts a new incident. Each completed run is recorded
once, even if its completion callback is repeated. Rejected queue admission does
not invent a target failure; the shared scheduler reports the rejected trigger.
Overlapping runs of the same monitor are rejected. **Run check now** also works
while its recurring schedule is paused.

Cron expressions use UTC, just like ordinary schedules. The schedule runs with
its creator's authorization and is disabled if that owner loses execution
permission or its source references are deleted. Pausing stops future triggers;
monitor history and open incident state remain visible. Deleting a monitor
cancels its active check and deletes its attached schedule/history/deliveries.

## Webhook notifications

Create an outbound webhook in **Settings → Integrations** and subscribe to
`monitor.incident` and/or `monitor.recovered`. These events use the existing
signed durable webhook queue, retries, delivery logs and adapter configuration.
They contain monitor/incident/run IDs, state, bounded numeric metrics and
threshold reasons. They contain no request URLs, response bodies, headers,
cookies or credential values. Incident IDs are shared by incident/recovery;
PagerDuty adapters use the same deduplication key for both events.

A state transition is queued in the same transaction as its sample and incident.
Receivers should deduplicate on the event/delivery ID because transport delivery
is at least once. Monitor notifications are separate from ordinary `run.*` events;
subscribe to the monitor events for threshold-based incidents.

## Email notifications

An administrator configures the SMTP relay through server environment variables:

| Variable | Meaning |
| --- | --- |
| `POSTBOX_SMTP_HOST` | SMTP relay hostname |
| `POSTBOX_SMTP_PORT` | Port; default 587, or 465 with secure mode |
| `POSTBOX_SMTP_FROM` | Sender email address |
| `POSTBOX_SMTP_USER` / `POSTBOX_SMTP_PASSWORD` | Optional relay credentials |
| `POSTBOX_SMTP_SECURE` | `true` for implicit TLS, usually port 465 |
| `POSTBOX_SMTP_REQUIRE_TLS` | STARTTLS required by default; set `false` only for an intentionally plaintext local/test relay |

Then add up to ten email recipients to a monitor. SMTP credentials remain in the
server environment; they are never returned by monitoring APIs or saved in
monitor samples. TLS certificates are verified and shared custom CA/client TLS
profiles apply. Direct relay connections enforce host policy, including resolved
addresses. An active outbound HTTP proxy requires an SMTP host bypass, since
this adapter uses direct SMTP sockets.

Email notifications have their own durable queue and stable `Message-ID` across
retries. Temporary SMTP/network failures retry up to six times with the existing
10-second, 1-minute, 5-minute, 30-minute and 2-hour backoff. Permanent SMTP errors
or policy blocks fail without retrying. One incident/recovery notification is
queued per recipient; delivery is at least once when an SMTP acknowledgement is
lost. Failed notifications can be explicitly retried from the dashboard, keeping
the same delivery identifier. Disabling SMTP configuration does not silently
discard queued mail: failed configuration is visible in delivery status.

## REST and MCP automation

Protocol-specific monitor endpoints are documented here, outside the v1
management OpenAPI inventory. They require the usual Postbox authentication and
workspace authorization. Readers can inspect monitors/history. Editors can
create/change/delete configurations; execution requires run access.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/monitors?workspaceId=ID` | List configurations and current states |
| POST | `/api/monitors` | Create a monitor and schedule |
| GET | `/api/monitors/ID?hours=168&before=CURSOR` | History, summary, incidents and delivery status |
| PATCH | `/api/monitors/ID` | Update with `expectedRevision` |
| DELETE | `/api/monitors/ID` | Delete monitor, schedule and attached data |
| POST | `/api/monitors/ID/run` | Queue a check; returns `{runId}` with HTTP 202 |
| POST | `/api/monitors/ID/retry-email` | Retry a failed `{deliveryId}` |

Creation body:

```json
{
  "workspaceId": "workspace-id",
  "folderId": "collection-id",
  "environmentId": null,
  "name": "Pets API",
  "cron": "*/5 * * * *",
  "enabled": true,
  "rules": {
    "maxLatencyMs": 500,
    "minAvailability": 100,
    "minAssertions": 100,
    "failAfter": 2,
    "recoverAfter": 2,
    "timeoutMs": 15000,
    "maxDurationMs": 60000
  },
  "emails": []
}
```

A patch includes the current `expectedRevision`; omitted fields remain unchanged.
A supplied `rules` object replaces the policy and applies defaults to its omitted
thresholds. Changing policy resets streak counters, preserving incident history.
History returns at most 500 entries per page, `hasMore` and `nextBefore` for older
samples. Pass that cursor unchanged as `before`; samples sharing a timestamp are not skipped. The summary still covers the whole selected range. `hours` is 1..2160.

MCP tools: `list_monitors`, `get_monitor`, `create_monitor`, `update_monitor`,
`delete_monitor`, `run_monitor`. ID-based tools use `monitorId`; update takes a
`patch` object containing `expectedRevision`. They enforce the same workspace and
API-key scopes as REST. Read-only MCP mode exposes inspection/execution but no
configuration mutations, consistent with existing runner tools.

## Retention and limits

**Settings → Data** includes `monitors.retentionDays` (default 90; zero disables
age deletion). Samples, resolved incidents and finished notification logs expire
under that setting. Open incidents and pending notification emails are retained.
Per-monitor caps always apply: 10,000 samples and 500 resolved incidents without
pending email. There are at most 50 monitors per workspace, ten recipients per
monitor, 1,000 pending emails per monitor and four concurrent SMTP deliveries per
process. Run admission uses the same global active/queued limits as other runs.
Request timeouts are 100..60,000 ms; admitted check deadlines are 1..300 seconds.

The SMTP implementation uses [Nodemailer’s SMTP transport](https://nodemailer.com/smtp) with an explicit policy-checked socket.

Workspace backups include monitor configuration, but not samples, incidents or notification queues. Restored monitors start paused with unknown state and no pending alerts; review and enable them explicitly. Backup restore waits for active/queued runs and monitor email sends to finish.
