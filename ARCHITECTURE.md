# Postbox Architecture

Postbox is a self-hosted, lightweight API client. It is a single Next.js
application (UI + API routes) backed by a single SQLite file. Everything that
touches the network or runs user scripts happens **server-side**, so the
browser never needs CORS permission from the target API and secrets never
need to leave the server except in the requests they are meant for.

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

## 1. Layers

| Layer | Location | Depends on | Notes |
|-------|----------|------------|-------|
| Core engine | `src/core/` | Node stdlib, small libs | Pure TypeScript, **no Next.js or DB imports**. Shared by the web app, the runner and the CLI. |
| Persistence | `src/server/db/` | Drizzle, better-sqlite3 | Schema, migrations, repositories that map rows to core types. |
| API routes | `src/app/api/**` | core + persistence | Thin HTTP handlers: validate input, call core, persist results. |
| MCP server | `src/server/mcp.ts`, `src/app/api/mcp/route.ts` | `@modelcontextprotocol/sdk` + core + persistence | Streamable HTTP MCP tools and resources for workspaces, collections, requests, environments, execution, runner, and import/export. |
| UI | `src/app/`, `src/components/`, `src/stores/` | React, Tailwind, shadcn/ui | Talks to the API only. Never reaches targets directly. |
| CLI | `src/cli/` | core | Newman-style headless runner, bundled to `dist/cli.mjs`. |

### Core engine modules

- `core/types.ts` – domain model (requests, folders, auth, body, variables, results).
- `core/variables/` – scope chain, `{{var}}` substitution, dynamic variables.
- `core/http/` – HTTP engine (`node:http`/`node:https`), body encoding, auth, cookie jar, host policy, timing.
- `core/scripts/` – QuickJS sandbox and the in-sandbox `pm.*` bootstrap.
- `core/executor.ts` – the full single-request pipeline (see §2).
- `core/runner/` – collection runner, iteration data parsing, reporters (JSON, JUnit, HTML).
- `core/convert/` – Postman v2.1 / environment / cURL / OpenAPI import, Postman export, code snippet generators.

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

The runner (§6) and the CLI call exactly the same `execute()` function with
an in-memory context, so behaviour is identical everywhere.

## 3. SQLite schema

All ids are text (nanoid). Timestamps are integer milliseconds. Structured
request parts are stored as JSON text columns because they are always read
and written as a unit.

```
workspaces     id PK, name, created_at, updated_at

folders        id PK, workspace_id FK→workspaces, parent_id FK→folders NULL,
               name, sort, description,
               auth JSON, headers JSON, pre_request_script, test_script,
               created_at, updated_at
               -- a folder with parent_id NULL is a *collection*

requests       id PK, workspace_id FK, folder_id FK→folders, name, sort,
               method, url, params JSON, headers JSON, body JSON, auth JSON,
               pre_request_script, test_script, settings JSON, examples JSON,
               description, created_at, updated_at

environments   id PK, workspace_id FK, name, sort, created_at, updated_at

variables      id PK, workspace_id FK,
               scope ('global' | 'collection' | 'environment'),
               owner_id (environment id | collection folder id | NULL for global),
               key, value, type ('default' | 'secret'), enabled, sort
               INDEX (workspace_id, scope, owner_id)

runs           id PK, workspace_id FK, folder_id, name, status
               ('running'|'passed'|'failed'|'cancelled'|'error'),
               options JSON, environment_id, iterations,
               total_requests, total_tests, passed_tests, failed_tests,
               duration_ms, started_at, finished_at

run_results    id PK, run_id FK→runs (cascade), iteration, sequence,
               request_id, name, method, url, status, status_text,
               time_ms, size, tests JSON, error, passed, created_at

history        id PK, workspace_id FK, request_id NULL, method, url,
               status, time_ms, size, request JSON, response JSON, created_at

cookies        id PK, workspace_id FK, domain, path, name, value,
               expires NULL, http_only, secure, same_site, host_only,
               created_at  UNIQUE (workspace_id, domain, path, name)

schedules      id PK, workspace_id FK, folder_id, environment_id, cron,
               options JSON, enabled, last_run_at, last_run_id

users          id PK, username UNIQUE, display_name, password_hash, is_admin,
               disabled, session_version, created_at, updated_at

api_tokens     id PK, user_id FK→users, name, token_hash UNIQUE, prefix,
               last_used_at, expires_at, revoked_at, created_at

server_secrets key PK, value, created_at   -- e.g. the account session key
```

Migrations are generated by `drizzle-kit` into `drizzle/` and applied at
server start (`src/server/db/index.ts`). The database file location comes from
`DATABASE_PATH` (default `/data/postbox.db`; `./data/postbox.db` in dev).

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
  rows to `POST /api/runs`. Row *n* becomes the `data` scope for iteration
  *n*, keyed by column header (`asn_id` → `{{asn_id}}`). When data is
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

## 7. Security

- **Authentication**: user accounts (scrypt password hashes, `v2` session
  cookies carrying the user id and a per-user session version, personal API
  tokens stored as SHA-256 hashes) or, until the first account exists, the
  single-user `POSTBOX_PASSWORD` / `POSTBOX_TOKEN` (`v1` cookies).
  `POSTBOX_TOKEN` stays valid as a recovery admin. `server/caller.ts` resolves
  every request to a caller (`open`, `env` or `user`); the Next.js `proxy`
  enforces it for every route except `/login`, `/api/auth/*` and `/api/health`.
- **Host policy**: `PROXY_ALLOW_HOSTS` and `PROXY_DENY_HOSTS` (comma
  separated, `*.example.com` wildcards and CIDR ranges supported). Deny wins.
  Checked for every hop of a redirect chain and for `pm.sendRequest`.
- **Sandbox** limits as in §5.
- **Workspace ownership**: any operation that combines a workspace with a
  folder, request, environment or variable owner checks that they belong
  together (`require*In` helpers in `server/repo.ts`, also used by
  `loadScopes`, `runSingleRequest` and `startRun`). A foreign ID is reported as
  `404`, exactly like a missing one, so other workspaces cannot be probed.
- **Input validation**: REST and MCP bodies are parsed with the shared schemas
  in `core/schemas.ts` (unknown keys are dropped, wrong shapes get `400`) and
  are capped at `API_BODY_LIMIT_MB` (`413` beyond it).
- **Logging**: the server logs request method/host/status only; resolved
  values of secret variables are redacted from console output, history and
  run results.

## 8. Deployment

- `next.config.ts` uses `output: "standalone"`.
- Multi-stage Dockerfile on `node:22-bookworm-slim`: build stage installs
  build tools to compile `better-sqlite3`, runtime stage copies the
  standalone bundle, static assets, migrations and the CLI bundle and runs as
  a non-root user. `/data` is a volume. Healthcheck hits `/api/health`.
- `docker-compose.yml` with a named volume, env vars and restart policy.

## 9. Roadmap

| Phase | Scope |
|-------|-------|
| 0 | Architecture document |
| 1 | Scaffold: Next.js, TypeScript, Tailwind, shadcn/ui, ESLint/Prettier, Vitest, Drizzle schema + migrations, `/api/health`, licence |
| 2 | Core engine: variable resolver, HTTP engine (timing, redirects, TLS toggle, cookies, auth incl. Digest/OAuth2), host policy, `/api/proxy`; tests |
| 3 | Script sandbox and `pm.*` API, console capture, executor pipeline with inheritance; tests |
| 4 | UI: workspaces, collection tree (nested folders, drag/drop, rename, duplicate, search), multi-tab request builder, response viewer, environments and variable editor, console panel |
| 5 | Collection runner: engine, iteration data grid, run UI, results, exports (JSON/JUnit/HTML); tests |
| 6 | Import/export (Postman v2.1, environments, cURL, OpenAPI) and code generation (cURL, fetch, Python, PowerShell) |
| 7 | History, command palette, keyboard shortcuts, optional auth, CLI runner |
| 8 | Docker, docker-compose, GitHub Actions (build, test, GHCR publish), README |
| 9 | Scheduled runs |
| Later | Desktop wrapper (Tauri/Electron), WebSocket/gRPC requests, OAuth2 authorization-code flow with PKCE, team sync |
