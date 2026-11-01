# Usage and quotas

Postbox keeps a usage ledger per workspace and can limit it. There is no billing and nothing is limited by default:
a limit exists only once an administrator sets one.

## What is counted

| Metric           | Unit     | Counted                                                                                              |
| ---------------- | -------- | ---------------------------------------------------------------------------------------------------- |
| API calls        | requests | Each request sent from the app, the REST API or MCP, and each request executed by a collection run.  |
| Collection runs  | runs     | Each run started, including scheduled and MCP runs.                                                  |
| Run time         | ms       | Wall-clock time of finished runs.                                                                    |
| AI usage         | tokens   | Reserved for AI features. Nothing records it today.                                                  |
| Retained storage | bytes    | What is kept now for history, run results and dataset versions. Measured, not counted over a period. |

Day and month periods are calendar periods in UTC.

## Retries count once

Send an `Idempotency-Key` header with `POST /api/proxy`. A second call with the same key in the same workspace is
still executed, but is not counted again. Collection runs are keyed by their run id.

## Quotas

Under Settings → Usage & quotas an administrator can set, per metric and per day or month:

- a **soft limit**: crossing it records one alert per period (shown in the dashboard and the audit log),
- a **hard limit**: passing it refuses the request or run with `429` and a message that names the limit.

A limit applies to **every workspace** (the default), to **one workspace** (it replaces the default there), or to
**one account** (a person or a service account), where it caps that identity across all workspaces. A request must
fit every limit that applies to it.

A run is refused up front when the run limit, the request limit or the run-time limit is already reached, or when
storage is over its limit; nothing is stored for a refused run. A run that was admitted always finishes, and its
requests and time are added when it ends. Storage is re-measured at most every 30 seconds.

Reservations are checked and recorded in one database transaction, so concurrent requests cannot jointly pass a
hard limit. This holds across server processes sharing one database file; the run queue itself is per process.

## Reading usage

- **Administrators:** Settings → Usage & quotas, every workspace, with alerts.
- **Workspace owners:** Settings → Workspace sharing → Usage, for that workspace.

Filter by date and download **CSV** or **JSON**.

```bash
curl -H "Authorization: Bearer pbx_…" "http://localhost:3000/api/admin/usage?from=2026-11-01&to=2026-12-01"
curl -H "Authorization: Bearer pbx_…" "http://localhost:3000/api/workspaces/<id>/usage?export=csv"
curl -X PUT -H "Authorization: Bearer pbx_…" -H "Content-Type: application/json" \
  -d '{"metric":"requests","period":"day","softLimit":800,"hardLimit":1000}' \
  http://localhost:3000/api/admin/usage/limits
```

## Reconciliation

`POST /api/admin/usage/reconcile` (or the buttons in the dashboard) compares the ledger with the run history for a
period. With `repair: true` it adds missing entries and corrects wrong amounts; running it again changes nothing.

## Retention

Ledger entries are kept for 400 days by default (Settings → History & data → Keep usage records for). Quotas only
look at the current day or month.
