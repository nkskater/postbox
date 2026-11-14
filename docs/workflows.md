# API workflows

Open **Workflows** in the API client's sidebar. The editor opens separately at `/flows`, so request tabs stay open. A workflow connects saved HTTP requests with conditions, transforms, bounded loops and reusable published workflows. It runs on the Postbox server, using the same request executor, scripts, environments, vault, host policy and workspace authorization as the client.

## Build and preview

1. Select a workspace and create a workflow. The starter graph passes its input to an output block.
2. Add blocks with the palette buttons or drag them onto the canvas. Drag a block's heading to move it. Click an output port, then the destination's input circle. The inspector's edge selectors offer the same operation with a keyboard. `Next` ends a branch when unconnected; conditions need both True and False destinations, and loops need a body.
3. Select a block to configure it. Request blocks select an existing saved HTTP request. Socket.IO, MQTT and gRPC profiles are not supported. Conditions require a boolean expression. Transform/output blocks evaluate an expression. Loop items must evaluate to an array; the body ends at an output or an unconnected Next. Loop results retain input order even with parallel iterations. A subflow selects a workflow and an explicit published version.
4. Edit expressions with the type/path fields or JSON editor. Click **Apply expression** or **Apply request bindings** after editing JSON. Validate the graph, fix unreachable blocks, missing references and ordinary cycles, then Save. Structured loops provide repetition; cycles in ordinary edges are rejected. Saves use revisions: a conflict requires Reload before retrying. Reload discards the canvas edits.
5. Supply input JSON and request fixtures, keyed by saved request ID. **Fill sample fixtures** fills the current graph's request blocks; add fixtures for requests in subflows too. **Preview fixtures** executes data/control flow without sending HTTP or running request scripts. It is available to readers. Fixtures have `status` (default 200), `data`, `headers`, and optional `testsPassed`. A missing fixture fails visibly; it never falls back to HTTP.
6. Inspect the output and select a trace step to see its data, branch/loop path, timing and error. Preview timing for a fixture request is always zero. **Run HTTP requests** sends the current canvas through the real executor, including inherited headers/auth/scripts and request tests. It can change remote systems. Failed HTTP responses (400+) and failed tests fail request blocks by default; an On error edge can explicitly handle them. Host errors, invalid data, permissions and limits stop execution.

Input JSON, fixture JSON and deployment settings are forms; saving a graph does not save those form values. Draft graph JSON can be copied/pasted under **Import / export graph JSON**. Import does not import saved requests or credentials; references must already exist in the same workspace. A workflow can have at most 200 blocks. Workspaces retain at most 100 workflows, 100 versions per workflow, and 50 deployments.

## Expressions and request bindings

Expressions are JSON trees, not scripts. A path reads `input`, `value` (the previous block's result), `steps.blockId`, or `item`/`index` inside a loop. Dotted paths and array indexes such as `value.data.items.0.id` are supported; prototype paths are rejected. Missing paths yield null. Each loop iteration has its own steps/current value; outer input is preserved. A condition leaves current value unchanged and records its boolean in `steps.conditionId`.

```json
{ "kind": "path", "path": "value.data.items" }
```

```json
{
  "kind": "op",
  "op": "eq",
  "args": [
    { "kind": "path", "path": "value.status" },
    { "kind": "literal", "value": 200 }
  ]
}
```

```json
{
  "kind": "object",
  "fields": {
    "id": { "kind": "path", "path": "item.id" },
    "source": { "kind": "literal", "value": "workflow" }
  }
}
```

Operations: `eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `and`, `or`, `not`, `add`, `subtract`, `multiply`, `divide`, `mod`, `concat`, `length`, `coalesce`, `contains`, `get`, `range`, `join`, `json`, `parseJson`, `sum`, `compact`, `merge`. Operations validate argument types; equality compares JSON structurally. Boolean operations and coalesce evaluate lazily. `range` takes a length or start/end, with optional step; generated arrays are bounded. `get` reads an own property, with an optional fallback. `json` serializes a value; `parseJson` parses text. Evaluation has fuel, depth and data limits.

Request bindings map a name to an expression:

```json
{ "customerId": { "kind": "path", "path": "input.customerId" } }
```

The saved request can use `{{flow.customerId}}`. Strings stay strings; other JSON values are serialized as JSON text. These external values stay literal during normal request-variable expansion, including template-shaped input such as `{{vault:key}}`. They do not become access to another variable. Input whose template fragments collide with trusted request/variable templates is rejected before HTTP to avoid changing trusted credentials. Bindings are data, not a substitute for trusted authentication. Explicit user scripts that deliberately call template expansion still have their normal script capabilities.

A real request produces `{status, headers, data, elapsedMs}`; `data` is parsed JSON where possible, otherwise text. Use a transform such as `value.data` to pass just the body forward. The output block chooses the workflow's final result. Without one, an ending block returns its current result.

## Versions and deployments

Save, then **Publish saved version**. Publishing requires workspace manage access and captures the graph, request content, inherited folder settings, and all pinned subflow versions. These execution artifacts are encrypted with the external vault keyring and verified against a content hash. Back up the keyring separately from the database. Vault key rotation re-encrypts artifacts before pruning old keys. An unreadable version fails closed; restore its key or publish a fresh version. Version numbers are never reused after deletion.

A version continues using pinned request/folder content after edits. Environment/global/collection variable values, vault secrets, network policy, account/key status and workspace roles are live. OAuth token caches refresh live only when the pinned OAuth configuration matches the current configuration. Saved requests and their original folders must still exist in the workspace; deletion withdraws their execution access. A published parent contains its own pinned child snapshots, so deleting an unused child version does not change it. **Load graph** loads version graph metadata onto the draft canvas; publishing that draft captures the then-current saved request content.

Create a deployment with an explicit version, optional environment, input JSON, five-field UTC cron and/or bearer webhook. New deployments are disabled by default. Enable explicitly when ready. The deployment runs with its saved creator's account and, when created through an API key, that key's current scope and revocation status. Service accounts require a valid key. Saving deployment settings adopts the current caller's identity and cancels its active/queued runs. Changing identity invalidates the previous webhook token, including while webhooks are disabled. Rotating a token also cancels its active runs. A workspace runner can manually invoke an enabled deployment; that invocation uses the deployment owner's authority, as does possession of its webhook token. Treat tokens as execution capabilities and grant them deliberately.

Disable to stop triggers and cancel queued/active work, then delete the deployment if needed. Deleting an environment fails closed; it does not silently select another environment. Disabling a deployment remains possible after environment deletion. Remove all deployments referencing a version before deleting it, and remove deployments before deleting a workflow. Deleting a workflow removes its run history.

Minute schedules use UTC and do not replay missed ticks after downtime. A duplicate scheduled delivery in the same minute uses the same idempotency key. An owner/key/role rejection appears as the deployment's last error. This scheduler targets the application's single persistent Node server and SQLite database; it is not a distributed scheduler or a serverless job service.

## Webhook and REST API

Workflow APIs are native routes outside the `/api/v1` management API. Account sessions and personal API keys use normal workspace scopes:

| Endpoint                             | Methods          | Access                                                                  |
| ------------------------------------ | ---------------- | ----------------------------------------------------------------------- |
| `/api/workflows?workspaceId=ID`      | GET              | read; includes request/environment choices and permissions              |
| `/api/workflows`                     | POST             | write; `{workspaceId,name,description?,graph?}`                         |
| `/api/workflows/ID`                  | GET, PUT, DELETE | read, write, manage; PUT requires `revision`                            |
| `/api/workflows/ID/validate`         | POST             | read; optional `graph`                                                  |
| `/api/workflows/ID/preview`          | POST             | read; `input`, optional `graph` or `version`, `fixtures`                |
| `/api/workflows/ID/runs`             | GET, POST        | read, run; POST `input`, optional `graph` or `version`, `environmentId` |
| `/api/workflows/ID/versions`         | GET, POST        | read, manage; POST `{revision}`                                         |
| `/api/workflows/ID/versions/N`       | GET, DELETE      | read, manage; GET returns graph metadata, not credentials/artifacts     |
| `/api/workflows/ID/deployments`      | GET, POST        | read, manage                                                            |
| `/api/workflow-runs/ID`              | GET              | read; redacted output, trace and provenance                             |
| `/api/workflow-runs/ID/cancel`       | POST             | run                                                                     |
| `/api/workflow-deployments/ID`       | GET, PUT, DELETE | read, manage, manage                                                    |
| `/api/workflow-deployments/ID/run`   | POST             | run; optional `{input}`                                                 |
| `/api/workflow-deployments/ID/token` | POST             | manage; `{revision}`                                                    |

Deployment creation accepts `name`, `version`, optional `environmentId`, `enabled`, `cron`, `webhookEnabled`, `input`. PUT accepts those fields plus required `revision`; workflow ID cannot be changed. Token creation/rotation returns plaintext once; GET returns only whether one is configured. Ordinary read responses never include its hash. Execution identities and source are chosen by the server; callers cannot supply them in REST bodies.

An enabled deployment's webhook accepts a raw JSON value, without an execution envelope:

```sh
curl -X POST 'https://postbox.example/api/workflow-triggers/DEPLOYMENT_ID?wait=1' \
  -H 'Authorization: Bearer wf_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: delivery-2026-11-10-001' \
  --data '{"customerId":"123"}'
```

`?wait=1` waits up to 25 seconds. HTTP 200 means the run is terminal; inspect `status` for passed/failed/cancelled. HTTP 202 means queued/running. Poll `GET /api/workflow-triggers/DEPLOYMENT_ID/runs/RUN_ID` with the same bearer token; it exposes only that deployment's status/output, not its configuration or full trace. Token rotation or disable invalidates both trigger and polling access. Accepted tokens are limited to 60 webhook submissions per minute per deployment. Input is at most 64 KiB; `Content-Type: application/json` is required.

`Idempotency-Key` is optional printable ASCII (1–128 characters, no spaces). While its run is retained, retries with structurally identical input return the original run; different input returns 409. It does not guarantee exactly-once remote side effects. Workflow history retains the newest 1,000 terminal runs per workspace; manual deletion/workflow deletion also removes their deduplication records. Keep durable delivery tracking in the caller for longer retry windows. Draft/normal run endpoints return HTTP 202 with `runId` and are not deduplicated.

## Limits, retention and recovery

Root graph limits apply to the entire invocation, including all nested loops/subflows: default 500 steps, 60 seconds and two concurrent request blocks, configurable up to 2,000 steps, 120 seconds and four request blocks. Loop iterations are additionally bounded (default 100, maximum 1,000) with up to four parallel iterations. Combined loop/subflow depth is eight; artifacts contain at most 64 distinct subflow versions and 2 MiB. Individual JSON values/responses are capped at 64 KiB, aggregate processed data at 4 MiB, graph JSON at 256 KiB, and stored traces at 512 KiB. Trace previews are bounded independently of execution output; omissions are visible. Limits include expression evaluation, and cancellation aborts active HTTP. Trusted request scripts retain their existing per-script and nested-HTTP limits; the workflow semaphore governs request blocks.

Workflows share collection-run admission and usage/storage quotas. Queue wait is bounded to two minutes. Script changes to global/environment/collection variables are isolated by default. An explicit root `persistVariables` setting enables the existing executor's variable persistence and requires serial loops throughout its subflows. Cookies and OAuth caches retain the request executor's normal persistence behavior.

Known scope/vault/auth credentials and sensitive fields are redacted from retained inputs, outputs, errors and traces. Returned secrets remain available internally for later blocks, but redacted copies are stored and shown. Avoid placing credentials in graph literals, ordinary input fields or non-secret configuration; use environment secrets or vault references. Literal credentials captured in request snapshots are encrypted, but graph metadata and user-supplied deployment input are normal workspace configuration, not a secret store. Storage accounting includes drafts, encrypted versions, deployments and run traces.

Restarted queued/running runs become **interrupted**, with a warning that side effects may already have occurred. They never replay automatically. Review the target system before retrying. Runs fail when actors/keys are disabled, revoked, deleted, expired or lose the required role/scope; authority is rechecked before every block and HTTP request. Disabling a deployment and cancellation cannot undo a request already accepted by the target.

Full workspace backups include workflow drafts, encrypted versions and deployment settings; keep the external vault keyring separately. Restored deployments are disabled with webhook tokens invalidated. Save each deployment to adopt a current owner, rotate its token and enable it deliberately. Exports without secrets retain scrubbed drafts and omit versions/deployments because snapshots contain encrypted request credentials. Run history and webhook deduplication records are not backed up.
