# Production traffic telemetry

Open **Telemetry** in the sidebar to connect an existing service's OpenTelemetry
trace exporter. This observes external server traffic; synthetic monitors and
capture proxy sessions remain separate features.

## Connect a source

1. Add a source with its exact resource `service.name`, environment label and
   sampling/retention settings. Sources default to disabled.
2. Copy the ingestion credential shown once. Configure an **OTLP/HTTP JSON**
   exporter or JSON-capable collector with the source URL and Authorization header.
   Standard binary protobuf and gRPC exporters cannot send to this connector.
3. Enable the source. Send HTTP SERVER spans (`kind: 2`) with trace/span IDs,
   start/end timestamps, HTTP method, route template or URL path, and optionally
   HTTP status and span status. Resource `service.name` must match the source.
4. Refresh the screen and select a time window. Last intake counters distinguish
   accepted, sampled-out, ignored, rejected, duplicate and evicted observations.

The source's endpoint is:

```text
POST https://postbox.example/api/telemetry/ingest/SOURCE_ID/v1/traces
Authorization: Bearer SOURCE_CREDENTIAL
Content-Type: application/json
Content-Encoding: gzip  # optional
```

For example, create a source through the authenticated management API (replace
`APP_TOKEN` with your normal Postbox token). The returned token is a separate,
write-only ingestion credential; an app token cannot ingest spans.

```bash
curl -X POST https://postbox.example/api/telemetry/sources \
  -H "Authorization: Bearer $APP_TOKEN" -H 'Content-Type: application/json' \
  -d '{"workspaceId":"WORKSPACE_ID","config":{"name":"Checkout","serviceName":"checkout","environment":"production"}}'
```

Set `SOURCE_ID` and `SOURCE_CREDENTIAL` from that response. Enable the source with
`PATCH /api/telemetry/sources/SOURCE_ID`, sending `expectedRevision: 1` and the full
configuration including `enabled: true`. Then send a current-time synthetic trace:

```bash
node --input-type=module <<'JS'
const end = BigInt(Date.now()) * 1000000n;
const body = {resourceSpans: [{
  resource: {attributes: [{key: 'service.name', value: {stringValue: 'checkout'}}]},
  scopeSpans: [{spans: [{
    traceId: '0123456789abcdef0123456789abcdef', spanId: '0123456789abcdef',
    kind: 2, startTimeUnixNano: String(end - 50000000n), endTimeUnixNano: String(end),
    attributes: [
      {key: 'http.request.method', value: {stringValue: 'GET'}},
      {key: 'http.route', value: {stringValue: '/api/orders/{orderId}'}},
      {key: 'http.response.status_code', value: {intValue: 200}}
    ]
  }]}]
}]};
const response = await fetch(`${process.env.POSTBOX_URL}/api/telemetry/ingest/${process.env.SOURCE_ID}/v1/traces`, {
  method: 'POST', headers: {'Content-Type': 'application/json', Authorization: `Bearer ${process.env.SOURCE_CREDENTIAL}`},
  body: JSON.stringify(body)
});
console.log(response.status, await response.text());
JS
```

A successful export returns HTTP 200 with `{}`. Invalid individual spans produce
an OTLP `partialSuccess` response with rejected span count; sampled-out, ignored
and duplicate spans are not protocol rejections. Malformed structure returns 400,
invalid credential 401, disabled source 403, oversized input 413, unsupported
encoding/content type 415. Rate limiting returns 429 and `Retry-After`. Credentials
travel only in the Authorization header; use HTTPS outside a trusted local host.

## Stored data and redaction

Only source/workspace identity, source revision, trace/span IDs, method,
normalized route, route origin, status/error flag, duration, completion time,
configured service/environment and sampling fraction are stored. Bodies, headers,
queries, hosts, user information, span names, arbitrary attributes, events and error
messages are discarded. Modern HTTP semantic attributes and legacy
`http.method`, `http.status_code`, `http.target`, `http.url` are supported.

`http.route` is preferred; without it the connector infers the endpoint from URL
path attributes. Numeric identifiers, UUIDs and template parameters become `:id`.
Only configured public literal path segments survive; all other segments become
`:segment`. Unknown routes are labeled `/[unmapped]`. Add public path words to the
allowlist to distinguish routes such as `/billing/checkout`; never allowlist
customer identifiers or secrets. Existing observations aren't rewritten by later
configuration changes. Fixed source service/environment labels avoid accepting
arbitrary resource labels from the exporter.

Sampling is deterministic on trace/span identity. This is additional sampling of
the spans your tracing system already exports. Retries are idempotent while an
observation is retained. Different sources remain separate, so exporting the same
span to multiple sources is reported under each source. Sampling changes preserve
the original fraction and revision on each observation. This is not a trace store:
use IDs to correlate failed examples with your existing tracing backend.

## Metrics and retention

Select source, exact service/environment, route substring and a half-open time
window (`from` inclusive, `to` exclusive, at most 30 days). “Endpoints with errors”
selects endpoints having at least one error while preserving their full sampled
request denominator. Endpoint identity includes source, service, environment,
method and normalized route.

Error rate counts HTTP 400–599 or span status ERROR. Percentiles use exact
nearest-rank durations over retained samples, with histogram buckets and up to 24
time buckets. Empty metrics are unknown, not zero-error success. Metrics don't
estimate total traffic and cannot correct upstream sampling bias. Span duration is
limited to one hour. The endpoint detail shows at most 20 recent failed metadata
examples; JSON export contains only the normalized data displayed by the app.

Each batch permits at most 1,000 spans, 100 resource groups, 100 scopes/resource,
128 attributes/span or resource, and 2 MiB both compressed and decoded. Gzip and
identity encoding are supported. Intake is limited to 120 batches/minute/source
per app process. At most 25 sources and 20,000 observations are retained per
workspace; each source retains 100–5,000 observations for 1–30 days (defaults:
2,000 observations, seven days). Source caps and workspace caps evict oldest
completion timestamps first. Observations outside the source retention window or
more than two minutes in the future are rejected. App workspace storage quotas
also apply. Retention runs every minute and on read/write; expired observations
are never returned by management reads. Disabling intake retains data until TTL
or purge. Purging removes observations; deleting a source cascades its data.

Source credentials are hashed at rest, never returned by reads, and revoked
immediately on rotation/deletion. Workspace readers can inspect telemetry; only
writers can manage sources or purge data. Backups preserve disabled source
configuration but omit observations and credentials, even with secrets included.
Restore always clears credentials and disables intake; rotate before enabling.

## Automation

All management endpoints require normal Postbox workspace authorization:

| Method               | Path                                       | Purpose                                |
| -------------------- | ------------------------------------------ | -------------------------------------- |
| GET / POST           | `/api/telemetry/sources`                   | List/create (`workspaceId` query/body) |
| GET / PATCH / DELETE | `/api/telemetry/sources/[id]`              | Read/edit/delete                       |
| POST                 | `/api/telemetry/sources/[id]/rotate`       | Rotate credential                      |
| DELETE               | `/api/telemetry/sources/[id]/observations` | Purge observations                     |
| GET                  | `/api/telemetry/metrics`                   | Inventory, distributions, timeline     |
| GET                  | `/api/telemetry/endpoints/[endpointId]`    | Endpoint and failed metadata           |

Edits send `{expectedRevision, config}`; rotations send `{expectedRevision}`.
Stale revisions return 409. Metrics/detail require `workspaceId` and accept `from`,
`to` (Unix milliseconds), `sourceId`, `service`, `environment`, `search`,
`errorsOnly=true`, `offset` and `limit` (1–100). The default is the previous hour.

Equivalent MCP tools: `list_telemetry_sources`, `get_telemetry_source`,
`create_telemetry_source`, `save_telemetry_source`, `delete_telemetry_source`,
`rotate_telemetry_source`, `purge_telemetry_source`, `get_telemetry_metrics`,
`get_telemetry_endpoint`. The latter two take `workspaceId` and `query` with
explicit `from` and `to`; endpoint lookup also takes `endpointId`. Source-scoped
tools take `sourceId`. MCP read-only mode excludes all mutations. Ingestion uses
the dedicated OTLP endpoint, never a general MCP tool.
