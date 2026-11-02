# Load testing

Run a collection or folder with many virtual users (VUs) and read throughput, error rate and latency percentiles.
Open a collection's **Runner** tab and choose **Load test**, or use the CLI, REST API or MCP.

## How it works

Each virtual user loops over the selected requests in order (collection → folder order), starting again when it reaches
the end, until the test ends. Every user has its **own copy** of the variables, data row and cookies:
changes made by scripts (`pm.environment.set`, …) are visible only to that user, and nothing is written back to the
workspace. With iteration data, user _n_ starts on row _n_ and advances one row per loop (rows repeat). Request scripts
and tests run on every request, so heavy scripts lower the throughput a machine can generate.

The shared host policy applies as for any request (`PROXY_ALLOW_HOSTS`, `PROXY_DENY_HOSTS`, outbound proxy), and the
generator is the Postbox server: its CPU and network cap what it can produce. Treat large numbers as measurements of
that machine as well as the target.

## Profiles

| Profile  | Settings                                                             | Shape                                                                    |
| -------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| constant | `vus`, `durationSec`                                                 | the same number of users throughout                                      |
| ramp     | `startVus` (default 0), `stages: [{durationSec, target}]` (up to 20) | users change linearly to each stage's target; a short stage makes a step |
| spike    | `baseVus`, `spikeVus`, `durationSec`, `spikeAtSec`, `spikeForSec`    | base level, jumping to `spikeVus` for a window, then back                |

Users are added immediately and removed gracefully: a user being retired finishes its current request first, so
ramp-down never cuts requests off. `thinkMs` pauses a user between its requests. When the profile ends, requests still
in flight get 3 seconds before they are cancelled; requests cancelled by the end of the test are not counted.

## Metrics

Latency is the total request time (DNS, connect, TLS, first byte and download). Percentiles come from a
log-bucket histogram accurate to about 1%, so memory stays bounded however long the test runs.

- **Requests, throughput (`rps`)**, bytes received, peak virtual users.
- **Errors**: a transport failure (no response) or an HTTP status of 400 or more. `errorRate` is errors / requests.
- **Checks**: assertions in test scripts. `checkFailRate` is failed / total checks.
- **Latency**: min, avg, p50, p90, p95, p99, max for the whole test and for each request name (up to 100 names; more are
  grouped as "(other requests)").
- Status-code counts, the most frequent error messages, and a time series (about 300 points) of requests, errors,
  throughput, p50, p95 and VUs.

## Thresholds

`metric op value`, with `op` one of `<`, `<=`, `>`, `>=`, optionally scoped to one request with `@Request name`:

```
p95<500          errorRate<0.01          rps>=20          p99<800@Create order
```

Metrics: `min`, `avg`, `p50`, `p90`, `p95`, `p99`, `max` (ms), `errorRate`, `checkFailRate` (0 to 1), `rps`, `requests`.
The test **passes** when every threshold holds and **fails** otherwise. A threshold with nothing to measure (a typo in a
request name, or no requests sent) fails rather than passing silently. With no thresholds a finished test passes.
A cancelled test has status `cancelled` and keeps the numbers gathered so far.

## Limits

Set in **Settings → Request execution** (or `LOAD_MAX_VUS`, `LOAD_MAX_DURATION_SEC`, `LOAD_MAX_REQUESTS`):

| Setting            | Default | Meaning                                                                |
| ------------------ | ------- | ---------------------------------------------------------------------- |
| Most virtual users | 100     | A profile above this is refused with HTTP 400, before anything runs    |
| Longest duration   | 600 s   | Likewise                                                               |
| Most requests      | 200,000 | The test stops once it has sent this many (`stoppedBy: "maxRequests"`) |

Load tests share the collection-run queue (**Concurrent collection runs**, queue length): a test waits behind running
tests, and a full queue answers 429. Workspace quotas for runs, run time and requests apply and count the test.
Starting a test needs the permission to run requests; viewers can read results. Cancel with the **Stop** button,
`POST /api/load-runs/:id/cancel`, the `cancel_load_test` tool, or `postbox load-run cancel`.

## UI

Choose the profile, think time and thresholds and press **Start load test**. The page shows live throughput, p95 and
virtual-user charts and then the full result: percentiles, threshold outcomes, a per-request table and export links
(JSON, CSV, JUnit). **Past tests** lists earlier tests of the collection; pick two and **Compare selected** to see how each
metric changed.

## REST

All routes need a signed-in user or token; the same workspace roles as collection runs apply.

| Method and path                                       | Behavior                                                                    |
| ----------------------------------------------------- | --------------------------------------------------------------------------- |
| `POST /api/load-runs`                                 | Start a test; streams NDJSON events (`queued`, `start`, `progress`, `done`) |
| `GET /api/load-runs?workspaceId=…`                    | Recent tests with headline numbers (optionally `folderId`)                  |
| `GET /api/load-runs/:id`                              | The stored test with the full result and time series                        |
| `POST /api/load-runs/:id/cancel`                      | Stop a running or queued test                                               |
| `DELETE /api/load-runs/:id`                           | Delete a finished test (409 while it runs)                                  |
| `GET /api/load-runs/:id/export?format=`               | `json`, `csv` or `junit` (one test case per threshold)                      |
| `GET /api/load-runs/compare?workspaceId=&base=&head=` | Change in each headline metric and each request's p95 and error rate        |

Request body of `POST /api/load-runs`:

```json
{
  "workspaceId": "…",
  "folderId": "…",
  "environmentId": null,
  "profile": {
    "type": "ramp",
    "stages": [
      { "durationSec": 30, "target": 50 },
      { "durationSec": 60, "target": 50 }
    ]
  },
  "thresholds": [{ "metric": "p95", "op": "<", "value": 500 }],
  "thinkMs": 100,
  "timeoutMs": 10000,
  "dataset": { "id": "…" },
  "selectedRequestIds": ["…"]
}
```

The test keeps running and is stored even if the client disconnects. Webhooks can subscribe to `load.passed`,
`load.failed`, `load.cancelled` and `load.error` (totals only).

MCP tools: `start_load_test` (returns the run id; the test runs in the background), `list_load_runs`, `get_load_run`
(`format` json, csv or junit), `cancel_load_test`, `delete_load_run`.

## Command line

Locally, against any Postman collection or HAR file, with no server:

```sh
postbox load api.json --vus 20 --duration 1m --threshold 'p95<400' --threshold 'errorRate<0.01'
postbox load api.json --stage 30s:50 --stage 2m:50 --stage 30s:0 --out report.csv --format csv
postbox load api.json --vus 5 --spike-vus 50 --duration 90s --spike-at 30s --spike-for 15s
```

It prints a summary, writes a report with `--out` (`json`, `csv`, `junit`), and exits **1 when a threshold fails**, so
it can gate a pipeline. `--max-vus` (default 200) and `--max-requests` (default 1,000,000) are local ceilings.

On a Postbox server:

```sh
postbox load-run start <folderId> -w <workspace> --vus 20 --duration 1m --threshold 'p95<400'   # waits; exit 1 on failure
postbox load-run list -w <workspace>
postbox load-run get <id>
postbox load-run export <id> --format junit --out load.xml
postbox load-run cancel <id>
```
