# Outbound webhooks

A workspace owner can have Postbox send a signed JSON `POST` to an address they control when something happens
in the workspace. Nothing is ever sent unless an owner has added a webhook, and the receiver is only called with
event data for that workspace.

Configure them in **Settings → Workspace sharing → Webhooks** (workspace owners and administrators), or through
the REST API below.

## Events

| Event           | Sent when                                                    |
| --------------- | ------------------------------------------------------------ |
| `run.passed`    | A collection run finished and every request and test passed. |
| `run.failed`    | A run finished with a failed request or test.                |
| `run.cancelled` | A run was cancelled.                                         |
| `run.error`     | A run stopped because of an internal error.                  |
| `webhook.test`  | You pressed **Send test**. Sent to that webhook only.        |

Scheduled runs and runs started from the CLI, MCP or the UI all produce the same events. Events for monitoring,
reviews and specifications will use the same mechanism when those features exist.

The body is JSON and carries totals only, never requests, responses or variable values:

```json
{
  "id": "Qk3…",
  "type": "run.failed",
  "createdAt": "2026-11-01T14:03:11.402Z",
  "workspaceId": "…",
  "data": {
    "runId": "…",
    "folderId": "…",
    "name": "Checkout suite",
    "status": "failed",
    "iterations": 1,
    "totalRequests": 12,
    "failedRequests": 1,
    "totalTests": 30,
    "passedTests": 28,
    "failedTests": 2,
    "durationMs": 4120,
    "startedAt": 1793541788000,
    "finishedAt": 1793541792120
  }
}
```

## Verifying a delivery

Each request has these headers:

| Header                     | Meaning                                                                             |
| -------------------------- | ----------------------------------------------------------------------------------- |
| `Postbox-Signature`        | `t=<unix seconds>,v1=<hex>`; the HMAC-SHA256 of `"<t>.<raw body>"` with your secret |
| `Postbox-Event`            | The event type                                                                      |
| `Postbox-Event-Id`         | The event id (the `id` field). Same on retries and replays                          |
| `Postbox-Delivery`         | One id per delivery, the same on every retry of it                                  |
| `Postbox-Delivery-Attempt` | 1 for the first try, 2 for the first retry, …                                       |

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(secret, rawBody, header) {
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=")));
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return false; // replay window
  const expected = createHmac("sha256", secret).update(`${parts.t}.${rawBody}`).digest();
  const given = Buffer.from(parts.v1, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
```

Verify the raw bytes you received, before parsing. The secret (`whsec_…`) is shown once, when you create the
webhook or rotate it. It is stored on the server so it can sign, and is never returned by the API, written to
the audit log or included in delivery logs. Rotating takes effect immediately, including for deliveries already
waiting.

## Delivery guarantees

Delivery is **at least once**. Deduplicate on `Postbox-Event-Id` (the same event replayed gets a new
`Postbox-Delivery`). Events are written to a durable outbox before anything is sent, so a restart does not lose
them; a delivery claimed by a worker that died is picked up again after a minute.

- A `2xx` response is success. Respond quickly: the request times out after 10 seconds.
- `408`, `425`, `429`, `5xx` and network errors are retried up to 6 attempts in total, waiting 10 seconds,
  1 minute, 5 minutes, 30 minutes and 2 hours. A `Retry-After` header lengthens a wait (up to an hour).
- Other `4xx` responses and redirects are permanent failures: redirects are never followed.
- Deliveries are sent concurrently and may arrive out of order; use `createdAt` to order them. At most 1000 can be waiting for one webhook; further events are
  recorded as failed with the reason.
- A webhook that is paused, or deleted, before its delivery is sent does not send it.

## Outbound policy

Targets use the same rules as requests: `PROXY_ALLOW_HOSTS` and `PROXY_DENY_HOSTS`, with the check repeated on
the resolved IP address for every attempt, so a name that later resolves to a blocked address is refused. The
address is also checked when you save it. URLs must be `http` or `https` and cannot contain credentials.
Plain `http` and private addresses are allowed unless your policy blocks them, as for requests.

## Delivery log

Each webhook keeps its deliveries with status (`pending`, `delivered`, `failed`), attempt count, last HTTP status
and error, and a log of every attempt. Open **Deliveries** to inspect them. **Replay** queues a finished
delivery again as a new delivery of the same event. Finished deliveries are removed after
`webhooks.retentionDays` (default 30, App Settings → History & data; 0 keeps them forever).

## REST API

All routes need workspace `owner` access (or an administrator) and a key with the `full` scope when the key is
scoped. Changes are recorded in the audit log without secrets.

| Route                                | Purpose                                                                             |
| ------------------------------------ | ----------------------------------------------------------------------------------- |
| `GET /api/webhooks?workspaceId=`     | List webhooks (no secrets)                                                          |
| `POST /api/webhooks`                 | Create `{workspaceId, name, url, events[], enabled?}`; returns the secret once      |
| `GET/PATCH/DELETE /api/webhooks/:id` | Read, change (`name`, `url`, `events`, `enabled`), delete                           |
| `POST /api/webhooks/:id/rotate`      | New secret, returned once                                                           |
| `POST /api/webhooks/:id/test`        | Queue a `webhook.test` event                                                        |
| `GET /api/webhooks/:id/deliveries`   | List (`?status=&limit=`), or `?delivery=<id>` for one with its attempts and payload |
| `POST /api/webhooks/:id/replay`      | Body `{deliveryId}`; queue a finished delivery again                                |

A workspace can have up to 20 webhooks.
