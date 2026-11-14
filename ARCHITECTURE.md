# Postbox Architecture

Postbox is a self-hosted API client: a Next.js application with a React UI,
Node server and SQLite persistence. Outbound API requests and user scripts run
server-side, so target APIs do not need to grant the browser CORS access.
The web app, REST API, MCP server, CLI and local Windows application share the
same core request engine; server services add identity, persistence and workers.

```
┌──────────────┐  JSON over HTTP   ┌──────────────────────────────────────────┐
│   Browser    │ ────────────────▶ │  Next.js server (Node runtime)           │
│  (React UI)  │ ◀──────────────── │                                          │
└──────────────┘                   │  /api/proxy ──▶ Executor ──▶ HTTP engine ├──▶ target API
                                   │  /api/mcp   ──┘     │   ▲                │
                                   │                     ▼   │                │
                                   │             Script sandbox (QuickJS)     │
                                   │                     │                    │
                                   │                     ▼                    │
                                   │             SQLite (Drizzle)             │
                                   └──────────────────────────────────────────┘
```

## 1. Layers and entry points

| Layer                      | Location                                                                                              | Responsibilities and dependencies                                                                                                                                                                   |
| -------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core engine                | `src/core/`                                                                                           | TypeScript domain models, validation, protocols and bounded execution. **No Next.js or database imports.** Shared by server services and CLI.                                                       |
| Persistence                | `src/server/db/`, `src/server/repo.ts`                                                                | SQLite connection, Drizzle schema/migrations and workspace content repositories. Feature services own their domain queries.                                                                         |
| Server services            | `src/server/`                                                                                         | Execution context, runs/workflows, vault, integrations, publishing, collaboration and governance. Combine core logic with persistence and authorization.                                            |
| Identity and authorization | `src/proxy.ts`, `src/server/auth.ts`, `caller.ts`, `authorize.ts`, `access-policy.ts`, `resources.ts` | Request gate, credential verification, caller context, API-key scopes, workspace roles and explicit REST/MCP policy inventories (§7).                                                               |
| REST handlers              | `src/app/api/**`, `src/server/http.ts`                                                                | Thin handlers behind `route()`: authorize, validate, call a service and return an HTTP response. The management API is a documented subset of these native routes, not a separate `/api/v1` prefix. |
| MCP server/client          | `src/server/mcp.ts`, `src/app/api/mcp/route.ts`, `src/server/mcp-client.ts`                           | Streamable HTTP tools/resources share server services and explicit tool authorization. Outbound MCP connections use the client service.                                                             |
| Public receivers           | `src/app/mock/`, `hook/`, `capture/`, selected `src/app/api/**` routes                                | Mock responses, incoming hooks, traffic capture, telemetry, runner agents and workflow triggers. Each receiver validates its own configured token/signature/capability (§7).                        |
| UI                         | `src/app/`, `src/components/`, `src/stores/`                                                          | React, Tailwind, shadcn/ui and CodeMirror. Calls Postbox APIs; server services reach target systems. Standalone pages include workflows and the gateway.                                            |
| CLI and editor extension   | `src/cli/`, `extensions/vscode/`                                                                      | Headless collection runner plus management commands; CLI bundle at `dist/cli.mjs`. The VS Code extension connects to a Postbox instance.                                                            |
| Local Windows application  | `desktop/`, `scripts/build-windows.mjs`, `scripts/build-desktop.mjs`                                  | Portable server distribution and Tauri desktop wrapper. The wrapper manages a local server and WebView; details in [Windows desktop](docs/windows-desktop.md).                                      |

### Core modules

- `types.ts`, `schemas.ts`, `scopes.ts`: shared request models, input validation and scope vocabulary.
- `variables/`, `http/`, `executor.ts`: variable resolution, HTTP/auth/cookies/host policy and the single-request pipeline (§2).
- `scripts/`, `packages/`, `visualizer/`: QuickJS sandbox, versioned script modules and isolated response visualizations.
- `runner/`, `load/`, `workflows/`: collection runs, load generation and validated bounded workflow graphs. Server orchestrators own queues, identity and retained results.
- `ws/`, `socketio/`, `mqtt/`, `grpc/`, `graphql/`: protocol-specific logic, separate from server session persistence and transport endpoints.
- `convert/`, `repository/`, `project/`, `git/`, `sdk/`, `management-api/`: import/export, repository formats, CLI projects, Git operations, generated clients and the management operation/contract registry.
- Feature directories such as `vault/`, `mocks/`, `monitoring/`, `specifications/`, `governance/`, `graph/`, `scorecards/`, `telemetry/`, `gateway/`, `sso/` and `scim/` hold domain validation/logic. Their `src/server/` counterparts provide database and account integration.

## 2. Data flow: sending a request

1. The UI posts the **current editor state** (which may be unsaved) to
   `POST /api/proxy` together with `workspaceId`, `environmentId` and, if the
   request is saved, its `requestId` (used to locate its parent folders).
2. The API route loads the context from SQLite: globals, the active
   environment, the owning collection's variables, the ancestor folder chain
   (for inherited auth, headers and scripts) and the workspace cookie jar.
3. `executor.execute()` runs the pipeline:
   1. Build the inheritance chain `collection → folder → … → request`.
   2. Run pre-request scripts from outermost to innermost
      (collection, folders, request) in the sandbox. Scripts may mutate
      `pm.request` and any variable scope.
   3. Resolve `{{variables}}` in URL, params, headers, body and auth using the
      scope chain (§4). Unresolved names are reported back to the UI.
   4. Resolve effective auth (`inherit` walks up the chain) and apply it.
   5. Check the target host against the allow/deny policy.
   6. Send via the HTTP engine: manual redirect handling (per-hop cookie
      handling), timeout, TLS verification toggle, decompression, and a timing
      breakdown (DNS, TCP, TLS, TTFB, download, total). Digest auth performs
      the challenge/response round-trip here.
   7. Run post-response scripts (collection → folder → request) with
      `pm.response` available. `pm.test` results and `console.*` output are
      collected.
4. Variable mutations (`pm.environment.set`, `pm.globals.set`,
   `pm.collectionVariables.set`) are returned as a diff and persisted by the
   API route. Cookies set by the target are persisted to the cookie jar.
5. A history entry is written (secret variable values are never stored in
   resolved form in logs; the history stores the template request plus the
   response).
6. The response, test results, console logs and timing are returned to the UI.

The runner (§6) and CLI reuse `execute()`. Server orchestrators additionally
apply current account/workspace authority, persistence, admission and usage limits.

## 3. Persistence areas

`src/server/db/schema.ts` is the authoritative schema; `src/server/resources.ts`
maps authorized resource kinds to their tables. The table groups below describe
all current feature areas without duplicating column definitions. Most entity IDs
are opaque text IDs and timestamps are integer milliseconds; composite keys and
JSON text columns are defined in the schema. Foreign keys and service-level checks
preserve workspace boundaries.

| Area                           | Tables                                                                                                                                           | Purpose and feature guide                                                                                                                                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace content              | `workspaces`, `folders`, `requests`, `environments`, `variables`                                                                                 | Collection roots are folders with no parent; child resources stay in their workspace. [Management API](docs/management-api.md)                                                                                                    |
| Saved iteration data           | `datasets`, `dataset_versions`                                                                                                                   | Versioned tables and secret-column metadata. [Datasets](docs/saved-datasets.md)                                                                                                                                                   |
| Execution and history          | `runs`, `run_results`, `load_runs`, `history`, `cookies`, `schedules`                                                                            | Collection/load results, retained request/response details, cookie state and schedules. [Load testing](docs/load-testing.md), [history and backup](docs/backup-and-data.md)                                                       |
| Visual workflows               | `workflows`, `workflow_versions`, `workflow_deployments`, `workflow_runs`                                                                        | Drafts, encrypted immutable execution artifacts, deployment owners/triggers and redacted run traces. [Workflows](docs/workflows.md)                                                                                               |
| Accounts and access            | `users`, `api_tokens`, `workspace_members`, `user_settings`, `invites`, `server_secrets`, `revoked_sessions`                                     | Accounts/service accounts, hashed keys, roles, preferences, invitations, signing material and sign-out revocations. [Accounts and security](docs/mcp-and-security.md), [service accounts/keys](docs/service-accounts-and-keys.md) |
| Federated identity             | `sso_providers`, `sso_identities`, `sso_states`, `sso_replay_cache`, `sso_role_grants`, `scim_groups`                                            | OIDC/SAML settings and login/replay state, identity links, provisioned groups and role grants. [SSO](docs/sso.md), [SCIM](docs/scim.md)                                                                                           |
| Vault and outbound credentials | `vault_secrets`, `broker_apis`, `broker_grants`, `outbound_proxy`, `tls_profiles`                                                                | Encrypted scoped secrets, credential-broker grants, proxy and TLS profiles; vault keyring remains outside SQLite. [Vault](docs/secrets-vault.md), [broker](docs/credential-broker.md), [network](docs/outbound-network.md)        |
| Script libraries               | `script_packages`, `script_package_versions`                                                                                                     | Workspace packages and immutable approved versions. [Script packages](docs/script-packages.md)                                                                                                                                    |
| Mocks and protocol definitions | `mock_servers`, `mock_logs`, `grpc_definitions`                                                                                                  | Mock configuration/logs and reusable gRPC definitions. [Mocks](docs/mock-servers.md), [gRPC](docs/grpc.md)                                                                                                                        |
| Outbound integrations          | `webhooks`, `webhook_deliveries`, `webhook_attempts`                                                                                             | Webhook configuration, signed delivery queue and retry history. [Outbound webhooks](docs/outbound-webhooks.md)                                                                                                                    |
| Inbound hooks and capture      | `hook_listeners`, `hook_events`, `capture_sessions`, `capture_entries`                                                                           | Incoming listener configuration/events and captured network traffic. [Incoming hooks](docs/incoming-webhooks.md), [capture](docs/traffic-capture.md)                                                                              |
| Outbound MCP                   | `mcp_calls`                                                                                                                                      | Saved MCP connection/tool-call configuration; live sessions are process-local. [MCP client](docs/mcp-client.md)                                                                                                                   |
| Monitors and private runners   | `monitors`, `monitor_samples`, `monitor_incidents`, `monitor_emails`, `runners`, `runner_jobs`                                                   | Monitor configuration/results/incidents, notification outbox and leased private-runner jobs. [Monitoring](docs/monitoring.md), [runners](docs/private-runners.md)                                                                 |
| API design and synchronization | `specifications`, `specification_versions`, `specification_links`                                                                                | Specification bundles/versions and request-generation/sync baselines. [Specifications](docs/specifications.md), [sync](docs/specification-sync.md)                                                                                |
| Governance                     | `governance_rule_sets`, `governance_rule_versions`, `governance_bindings`, `governance_reports`                                                  | Versioned policies, assignments, exclusions/overrides and reports. [Governance](docs/governance.md)                                                                                                                               |
| Dependency graph               | `graph_sources`, `graph_nodes`, `graph_edges`                                                                                                    | Rebuildable dependency indexes for workspace resources. [Dependency graph](docs/dependency-graph.md)                                                                                                                              |
| Quality scorecards             | `quality_scorecards`, `quality_scorecard_versions`, `quality_bindings`, `quality_reports`                                                        | Versioned scorecards, catalog assignments and evaluation reports. [Scorecards](docs/scorecards.md)                                                                                                                                |
| Publishing and discovery       | `documentation_publications`, `catalog_entries`, `catalog_versions`                                                                              | Published documentation and catalog metadata/version snapshots. [Documentation](docs/collection-documentation.md), [catalog](docs/api-catalog.md)                                                                                 |
| Collaboration and reuse        | `comments`, `comment_notifications`, `dependency_releases`, `dependency_installs`, `collection_forks`, `merge_requests`, `merge_request_reviews` | Resource comments, shared dependency snapshots, collection forks and reviewed merges. [Comments](docs/comments.md), [dependencies](docs/shared-dependencies.md), [forks](docs/forks-and-merge-requests.md)                        |
| Telemetry                      | `telemetry_sources`, `telemetry_observations`                                                                                                    | Intake configuration and retained observations for metrics/reproduction. [Telemetry](docs/telemetry.md)                                                                                                                           |
| Managed gateway                | `gateway_routes`, `gateway_traces`, `gateway_sessions`                                                                                           | Gateway policies, usage/session state and redacted traces; providers use the credential broker. [Gateway](docs/gateway.md)                                                                                                        |
| Administration and quotas      | `app_settings`, `audit_events`, `usage_events`, `usage_limits`, `usage_alerts`                                                                   | Instance settings, audit history and usage/admission accounting. [Audit](docs/audit-log.md), [usage](docs/usage-and-quotas.md)                                                                                                    |

`src/server/db/index.ts` lazily opens the configured SQLite file, enables WAL and
foreign keys, and applies generated migrations from `drizzle/`.
`DATABASE_PATH` defaults to `/data/postbox.db` in production and
`./data/postbox.db` in development; `MIGRATIONS_PATH` can override migration lookup.
Edit the schema and run `npm run db:generate` for changes; never edit applied migrations.
[Backup and data maintenance](docs/backup-and-data.md) distinguishes configuration
exports from a full database/volume backup. Preserve the external vault keyring
separately for encrypted secrets and workflow artifacts.

## 4. Variables

Scopes, from lowest to highest precedence (Postman semantics):

```
global  <  collection  <  environment  <  iteration data  <  local
```

- `local` variables are set via `pm.variables.set()` and live for a single
  request execution (or a single runner iteration).
- `{{name}}` substitution is recursive (a value may reference another
  variable) with a depth limit of 10 to prevent cycles.
- Dynamic variables start with `$`: `{{$guid}}`, `{{$randomUUID}}`,
  `{{$timestamp}}`, `{{$isoTimestamp}}`, `{{$randomInt}}`,
  `{{$randomAlphaNumeric}}`, `{{$randomEmail}}`, `{{$randomFirstName}}`, ….
- Variables of type `secret` are masked in the UI, never written to logs and
  are excluded from exports unless explicitly requested.
- Disabled variables are ignored by the resolver.
- The resolver reports unresolved names so the UI can highlight them.

## 5. Script sandbox

User scripts run in **QuickJS compiled to WebAssembly**
(`quickjs-emscripten`). It was chosen over `isolated-vm` because it needs no
native compilation, works on every Node version and inside slim containers,
and still gives a true isolate: the script has no access to Node APIs, the
filesystem, `require`, or the host's globals.

- **Limits**: per-script memory limit (default 32 MB), wall-clock deadline
  enforced by an interrupt handler (default 5 s, configurable by
  `SCRIPT_TIMEOUT_MS` / `SCRIPT_MEMORY_MB`), max stack size.
- **Bridge**: the host injects a small set of functions (`__host.log`,
  `__host.sendRequest`, `__host.setTimeout`) and a JSON snapshot of the
  execution context. All values cross the boundary as JSON strings, so no host
  object references leak into the sandbox. Everything coming back from the
  guest (`pm.sendRequest` arguments, console levels and the final state) is
  validated against `core/schemas.ts` before the host acts on it, because user
  code can replace any guest-side helper.
- **pm API** (implemented in JavaScript inside the sandbox):
  `pm.environment`, `pm.globals`, `pm.collectionVariables`, `pm.variables`,
  `pm.iterationData` (`get/set/unset/has/clear/toObject/replaceIn`),
  `pm.request` (url, method, headers, body; mutable in pre-request scripts),
  `pm.response` (`code`, `status`, `headers`, `responseTime`, `responseSize`,
  `text()`, `json()`, `to.have.status()`, …), `pm.test`, `pm.expect`
  (chai-style BDD assertions), `pm.sendRequest` (callback and promise form),
  `pm.info`, `pm.cookies`, `pm.execution.skipRequest()`,
  `pm.execution.setNextRequest()`, `console.*`. Legacy `postman.setNextRequest`
  and `tests[...]` are also supported.
- **Async**: host operations return QuickJS promises. The host keeps pumping
  pending jobs until all promises and timers settle or the deadline passes.
- After the script finishes, the sandbox serialises the mutated scopes,
  request, test results and logs back to the host.

## 6. Collection runner

- Input: a folder/collection, an environment, iteration data rows and
  options (`iterations`, `delayMs`, `stopOnFailure`, `timeoutMs`).
- Items are flattened depth-first in sort order. Each iteration runs every
  item sequentially through `execute()`. `setNextRequest(name|null)` can jump
  or stop.
- Iteration data: CSV, JSON (array of objects) and XLSX are parsed into
  `{ columns, rows }`. The browser shows an editable data grid (edit cells,
  delete rows/columns, trim whitespace, dedupe, filter) and sends the final
  rows to `POST /api/runs`. Row _n_ becomes the `data` scope for iteration
  _n_, keyed by column header (`asn_id` → `{{asn_id}}`). When data is
  provided the iteration count defaults to the number of rows.
- Progress is streamed to the browser as newline-delimited JSON events;
  results are persisted to `runs` / `run_results`.
- Completed results record the effective request before redirects (method, URL,
  prepared headers and up to 64 KB of request text), response headers, final URL,
  timings and up to 1 MB of response text per execution. Secret values are
  redacted before applying the response retention limit. Uploaded request bodies
  and binary response bodies are not retained as text. Engine capture limits,
  recording limits and older records without full details are shown explicitly
  in the result detail view; transport-added request headers are not recorded.
- Reporters: JSON, JUnit XML, standalone HTML. The CLI uses the same
  reporters plus a console reporter.

## 7. Request gate and authorization

There are two HTTP layers before a workspace service is called:

1. **Request gate (`src/proxy.ts`).** Next.js runs it before route handlers.
   `src/server/auth.ts` contains database-free credential/session primitives and
   `isPublicPath()`; `caller.ts` resolves open mode, environment recovery credentials,
   account sessions and personal API keys. The gate checks cross-origin writes,
   authentication, failed bearer attempts and per-key request limits. It also
   attaches the app's nonce-based Content-Security-Policy via `server/csp.ts`.
   Protected API requests without identity return 401; pages redirect to sign-in.
2. **Route authorization (`src/server/http.ts`, `access-policy.ts`).** `route()`
   matches method/path against `REST_POLICIES`. Public handlers take their own
   authentication/validation path; other handlers resolve a caller and enter
   `withCaller()` context after `authorizeRest()`. Policies distinguish admin/account
   actions, workspace IDs in query/body, and resource IDs resolved through
   `resources.ts`. `authorize()` intersects API-key scope with workspace role.
   Service/repository checks also reject foreign resource combinations, using 404
   where revealing another workspace's resource would leak information.

For a new REST handler, use `route()` and register every exported method in
`REST_POLICIES`. Register a new resource kind in `resources.ts` when required.
For a public API path, update `isPublicPath()` too: the gate must allow it before
its public handler can run. `tests/workspace-access.test.ts` checks route/tool
inventory and workspace isolation; `tests/public-api-policy.test.ts` compares
registered API paths to both public classifications, including protected child
routes and representative dynamic/catch-all paths. The gate classifies paths;
method-specific policy and receiver credentials remain handler responsibilities.

The MCP endpoint is authenticated at the gate. Its tool-registration wrapper in
`src/server/mcp.ts` calls `authorizeTool()` against `MCP_POLICIES` before invoking
services. That check resolves every referenced workspace/resource and applies the
required action, rather than trusting a client-supplied workspace alone. New tools
must be classified there too. See [MCP and workspace security](docs/mcp-and-security.md)
and [service accounts/API keys](docs/service-accounts-and-keys.md).

### Public entry points and receivers

Public at the gate means reachable before a normal account session; it does not
mean every receiver accepts unauthenticated data:

- `/api/health` and `/api/openapi.json` are anonymous status/contract endpoints.
  The OpenAPI response describes the management API, never instance workspace data.
- `/login`, `/invite` and `/api/auth/*` serve account/bootstrap/invitation and SSO
  flows. Login, callback and invitation handlers enforce their own credentials,
  one-use state, replay/origin rules and throttles.
- `/api/catalog` and `/api/documentation/[id]` expose enabled publications.
  Their import/configuration child routes remain protected.
- `/mock/[id]/...`, `/hook/[token]/...` and `/capture/[token]/...` route to
  `server/mocks.ts`, `hook-listeners.ts` and `capture.ts`, enforcing their receiver
  configuration, keys/signatures/tokens and bounds.
- `/api/telemetry/ingest/[id]/v1/traces` validates the source intake token and
  telemetry limits. `/api/runner-agent/lease` and its job heartbeat/result routes
  authenticate a private-runner token and job lease in `server/runners.ts`.
- `/api/workflow-triggers/[id]` and its run-status child validate a deployment
  bearer capability, current owner/key authority and invocation limits.

### Other boundaries

Accounts use scrypt password hashes and signed session cookies. Account sessions
carry a per-user version; sign-out revokes the current session on the server.
`POSTBOX_TOKEN` remains a recovery administrator credential. Vault ciphertext lives
in SQLite while keys live outside it; collection/user scopes and allowed domains
control decryption and outbound use. Host allow/deny policy applies to every HTTP
redirect and nested `pm.sendRequest`; the sandbox has its own execution limits (§5).
Shared schemas and bounded body readers validate REST/MCP input. Audit wrappers
record relevant mutations/denials, and retained execution data uses credential and
sensitive-field redaction. Each feature guide describes its additional limits.

### Process startup and background work

`src/instrumentation.ts` installs the client-address hook for Node requests. Outside
production build, it starts collection/monitor scheduling (`server/scheduler.ts`),
workflow scheduling (`server/workflows/scheduler.ts`), telemetry retention,
outbound webhook delivery and the monitor email outbox worker. These services own
their timers, queues, retry/lease state and current-authority checks; they must not
start during a build. Workflow restart recovery marks unfinished runs interrupted
rather than replaying side effects. The runtime assumes one persistent Node server
and SQLite database; distributed workers require their documented private-runner
protocol, not duplicate in-process schedulers sharing a file.

## 8. Deployment

- `next.config.ts` uses `output: "standalone"`.
- Multi-stage Dockerfile on `node:22-bookworm-slim`: build stage installs
  build tools to compile `better-sqlite3`, runtime stage copies the
  standalone bundle, static assets, migrations and the CLI bundle and runs as
  a non-root user. `/data` is a volume. Healthcheck hits `/api/health`.
- `docker-compose.yml` with a named volume, env vars and restart policy.

## 9. Development and validation

Start with [AGENTS.md](AGENTS.md), the
[shared lifecycle](tools/development-workflow/WORKFLOW.md) and
[repository workflow configuration](.github/development-workflow.json).
Jira is the delivery backlog; the feature guides linked above describe implemented
behavior and limitations. Keep changes within their layer and use current installed
Next.js documentation under `node_modules/next/dist/docs/` for framework APIs.

Run the configured unit/integration, type, lint and production-build checks, plus
production browser tests for UI behavior. Add an authorization inventory entry and
boundary regression with a new route/tool; exercise migrations on existing data
when changing persistence. [Application tests](docs/application-tests.md) documents
user-facing network capture/assertion testing separately from the repository tests.
