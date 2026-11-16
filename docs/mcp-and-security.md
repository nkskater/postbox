# MCP controls and security settings

Open **Settings → MCP & integrations** or **Settings → Security & about** (administrators only).

## MCP endpoint

| Setting                 | Default  | Environment pin       | Effect                                                                                                                                      |
| ----------------------- | -------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Enable the MCP endpoint | on       | `MCP_ENABLED`         | When off, `POST /api/mcp` answers HTTP 503 and no tool runs.                                                                                |
| Read-only MCP           | off      | `MCP_READ_ONLY`       | Tools that create, change or delete data are hidden from `tools/list` and refused if called anyway.                                         |
| Default MCP toolsets    | `core`   | `MCP_TOOLSETS`        | Comma-separated domains advertised by default, or `all` for the complete list. Query selection overrides this default.                      |
| Extra allowed origins   | _(none)_ | `MCP_ALLOWED_ORIGINS` | Comma-separated browser origins that may call `/api/mcp`. Postbox's own origin and clients that send no `Origin` header are always allowed. |

When an environment variable is set it pins the setting and the control is locked.

**What read-only allows.** Every tool is classified by the access it needs. Read-only keeps the
tools that read or list data, identify the caller, send a request or run a collection; it removes
the rest (create, update, delete, move, duplicate, import, set variables, clear history and
cookies, manage examples, create or delete workspaces). Sending a request or running a collection
still records history and run results, because testing an API is the main use of MCP. A new tool
without a classification is treated as changing data.

**Connect a client.** The panel shows commands with your server's address filled in. They use
`YOUR_TOKEN`: create a personal API token on your profile page and substitute it. If sign-in is
off the commands carry no token.

## Tool discovery and compatibility

`/api/mcp` advertises only the **core** group by default. Select other domains in
the connection URL:

- `/api/mcp?toolsets=core,mocks` advertises both groups.
- `/api/mcp?toolsets=mocks` advertises mocks alone.
- `/api/mcp?toolsets=all` restores the complete discovery list for existing clients.

Administrators can edit **Default MCP toolsets** under **Settings → MCP & integrations**;
`MCP_TOOLSETS` pins that setting. It applies to the next discovery request when the
URL has no selection. Refresh the tools or reconnect if a client caches its list.
Use one comma-separated query parameter. Names are case-sensitive; empty, unknown
and mixed `all,core` selections return HTTP 400. Duplicates are normalized.

| Toolset        | Tools                                                                                                                              |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `core`         | Identity, workspaces, collections/folders, requests, environments, variables, send, collection runs, history, cookies and exports. |
| `mocks`        | Mock configuration, snapshots, logs, scenarios and handlers.                                                                       |
| `monitors`     | Monitor configuration and execution.                                                                                               |
| `specs`        | Specifications, collection synchronization, import and request contracts.                                                          |
| `governance`   | Rules, bindings, linting and reports.                                                                                              |
| `scorecards`   | Quality scorecards, sources and reports.                                                                                           |
| `datasets`     | Saved datasets, versions, import and export.                                                                                       |
| `vault-broker` | Vault metadata and credential-broker access/calls.                                                                                 |
| `telemetry`    | Sources, metrics, intake endpoints and reproduction plans.                                                                         |
| `catalog-docs` | Catalog search/publication/import, documentation and generated SDKs.                                                               |
| `capture`      | Capture sessions, entries and conversion to requests.                                                                              |
| `load`         | Load-test execution and retained results.                                                                                          |
| `packages`     | Workspace script packages and approved versions.                                                                                   |
| `graph`        | Dependency search, traversal, paths and refresh.                                                                                   |
| `comments`     | Resource discussions and resolution.                                                                                               |
| `examples`     | Saved request response examples.                                                                                                   |
| `codegen`      | Code-snippet targets and generation.                                                                                               |

Toolsets control **advertising**, not permission. A client that already knows a
hidden tool name can still invoke it with the same arguments. Workspace roles,
API-key scopes and administrator-only operations are checked on every call.
Read-only MCP still hides and refuses all mutating tools, even if a client selects
`all` or calls a name directly.

Discovery schemas keep names, descriptions and structural hints, using local
`$defs`/`$ref` for repeated shapes. They use [MCP's default JSON Schema 2020-12 dialect](https://modelcontextprotocol.io/specification/2025-11-25/basic/index#json-schema-usage).
Auth describes its `type` plus provider fields, and body describes its `mode` plus
mode-specific fields. The original complete schemas still validate every call,
including provider credentials, body fields, ranges and defaults. For example,
bearer auth remains `{ "type": "bearer", "bearer": { "token": "<token>" } }`, and a
raw JSON body remains `{ "mode": "raw", "raw": "{\"id\":1}", "language": "json" }`.

Definitions and SDK handlers are compiled once per read-only mode. Selected lists
use a bounded cache; each HTTP request still owns its protocol, transport,
cancellation and caller context. Caller identities, permissions, workspace data
and tool results are never cached by this registry. Tests enforce discovery
budgets below 40 kB for core and 120 kB for all tools.

## Browser request protection

- **Cross-origin writes.** API requests that change data (`POST`, `PUT`, `PATCH`, `DELETE`) and rely on the
  session cookie are accepted only from Postbox's own origin; other sites get HTTP 403, including other services
  on the same host. Requests with an `Authorization` header and clients that send no `Origin` header (CLI, curl,
  scripts) are unaffected. Behind a reverse proxy that rewrites `Host` without forwarding `X-Forwarded-Host`, list
  the public origin in `POSTBOX_ALLOWED_ORIGINS`. Mock servers, webhook listeners, capture sessions and telemetry
  ingest stay reachable from anywhere; `/api/mcp` uses its own allow-list above.
- **Framing.** Pages and API responses send `X-Frame-Options: SAMEORIGIN`, `X-Content-Type-Options: nosniff` and
  `Referrer-Policy: same-origin`, so other sites cannot embed Postbox.
- **Content-Security-Policy.** App pages send an enforced policy with a fresh nonce per page: scripts only from
  Postbox itself or with that nonce (no `eval`), connections and frames only to Postbox (plus `data:`/`blob:`
  previews), `frame-ancestors 'self'`, `base-uri 'self'` and `form-action 'self'`. Requests you send never come
  from the page; the server sends them, so the policy does not limit which APIs you can call. API routes, the
  published documentation and catalog pages, and the mock, webhook and capture receivers keep their own headers.
- **HTTPS.** Responses to requests that reached Postbox over HTTPS (directly or with `X-Forwarded-Proto: https`
  from a reverse proxy) send `Strict-Transport-Security: max-age=31536000`.

## Sign-in and sessions

- **Sign out** ends the session on the server, not only in the browser: the cookie stops working everywhere,
  including any copy of it. Your other browsers stay signed in.
- **Profile → Sign out of all sessions** ends every browser session of your own account, this one included.
  Personal API tokens keep working.
- **New sessions last** sets how long a new sign-in stays valid (1–365 days, `POSTBOX_SESSION_DAYS` pins it).
  Existing sessions keep the length they were created with.
- **Sign out all sessions** (`POST /api/admin/sessions/revoke`) ends every browser session, yours
  included: each account's session version is bumped and the single-user password session key is
  rotated. Personal API tokens and `POSTBOX_TOKEN` are not affected; revoke tokens separately.
- **About** shows the version and, for Docker images built with
  `--build-arg POSTBOX_COMMIT=$(git rev-parse --short HEAD)`, the build commit. `GET /api/admin/security`
  reports sign-in mode, whether `POSTBOX_PASSWORD` / `POSTBOX_TOKEN` are configured (never their values),
  the session length and version.
