# Postbox

A self-hosted, lightweight, open-source alternative to Postman. It runs as a Docker web app on your LAN.
Requests, scripts and collection runs all execute on the server, so you get no CORS problems and
secrets stay on the server.

> Screenshots: _coming soon_

## Features (working today)

- **Request builder**: every method; params, headers and body (raw JSON/XML/text/HTML/JS, form-data with file upload,
  urlencoded, binary, GraphQL); auth (Bearer, Basic, API key, Digest, OAuth 2.0 client-credentials/password/manual);
  per-request settings (timeout, redirects, SSL verify, cookie jar). Multi-tab editing with unsaved-draft persistence.
- **Collections**: nested folders, drag & drop, rename, duplicate, search. Auth, headers and scripts set on a collection or folder are inherited by everything inside.
- **Scripts**: sandboxed (QuickJS/WASM, with memory and time limits) Postman-compatible `pm.*` API: variables, `pm.request`,
  `pm.response`, `pm.test`, `pm.expect` (chai-style), `pm.sendRequest`, `setNextRequest`. Includes a console panel.
- **Variables**: global, collection, environment, iteration-data and local scopes, with Postman precedence. Supports `{{var}}` highlighting
  and autocomplete, dynamic variables (`{{$guid}}`, `{{$timestamp}}`, `{{$randomInt}}`, …) and masked secrets.
- **Collection runner**: CSV/JSON/XLSX iteration data with an editable grid (edit cells, delete rows/columns, trim,
  dedupe, filter). Options for iterations, delay and stop-on-failure. Live results, export to JSON, JUnit and HTML.
- **Response viewer**: status, timing breakdown (DNS/TCP/TLS/TTFB/download), size, headers, cookies; Pretty/Raw/Preview with folding and search;
  test results; save as example.
- **Import/export**: Postman v2.0/v2.1 collections and environments, OpenAPI 3 and Swagger 2 (from a file, pasted text or a URL), and cURL
  (paste one into the URL bar). Code snippets for cURL, fetch, Python and PowerShell.
- **MCP server (`/api/mcp`)**: Streamable HTTP Model Context Protocol endpoint so Claude Code, Open WebUI, Cursor and other MCP clients can inspect workspaces, create/edit collections, folders, environments and requests, execute single requests, run collections with iteration data, and import/export specs.
- History, cookie manager, command palette (Ctrl+K) and keyboard shortcuts (press `?` in the app).

## Quick start (Docker)

```bash
git clone https://github.com/nkskater/postbox.git
cd postbox
docker compose up -d --build
# open http://<server-ip>:3000
```

Data lives in the `postbox-data` volume (`/data/postbox.db`). To use a bind mount instead, replace the volume with
`./data:/data` and make the directory writable by UID 1001.

## Development

```bash
npm install
npm run dev        # http://localhost:3000, DB at ./data/postbox.db
npm test           # Vitest: resolver, proxy, sandbox, executor, runner, converters, repository, mcp
npm run lint && npm run typecheck
npm run db:generate  # after changing src/server/db/schema.ts
```

## Configuration

| Variable | Default | Description |
|---|---|---|
| `DATABASE_PATH` | `/data/postbox.db` (prod), `./data/postbox.db` (dev) | SQLite file |
| `PORT` | `3000` | HTTP port |
| `POSTBOX_PASSWORD` | _(none)_ | Enables login with this password |
| `POSTBOX_TOKEN` | _(none)_ | Enables `Authorization: Bearer` access (API, MCP, automation) |
| `POSTBOX_SESSION_SECRET` | _(derived)_ | Optional explicit key for signing session cookies |
| `POSTBOX_SESSION_DAYS` | `30` | Session lifetime |
| `PROXY_ALLOW_HOSTS` | _(all)_ | Comma list of hosts, `*.wildcards` or CIDRs requests may target |
| `PROXY_DENY_HOSTS` | _(none)_ | Comma list that is always blocked (wins over allow) |
| `SCRIPT_TIMEOUT_MS` | `5000` | Per-script time limit |
| `SCRIPT_MEMORY_MB` | `32` | Per-script memory limit |
| `RESPONSE_MAX_BYTES` | `52428800` | Encoded response bytes are truncated at this limit; decompression exceeding the limit at any stage is rejected |
| `MCP_ALLOWED_ORIGINS` | _(none)_ | Extra browser origins allowed to call `/api/mcp` (cross-origin browser requests are rejected otherwise) |
| `HISTORY_LIMIT` | `500` | History entries kept per workspace |

### Authentication

Set either or both of these to require authentication for the UI and every API route, including `/api/mcp`.
`/api/health` and `/login` stay public.

- `POSTBOX_PASSWORD`: enables the `/login` page, which issues a signed, HTTP-only session cookie (default 30 days).
- `POSTBOX_TOKEN`: accepted as `Authorization: Bearer <token>` for scripts and MCP clients (and on the login form).

Changing either value signs everyone out. With neither set, Postbox is open. Only run it that way on a trusted network.

## Running behind a reverse proxy

Postbox is a single HTTP service. Collection runs stream progress as NDJSON, so turn off response buffering.

Runs continue saving results if the browser disconnects. A progress subscriber whose
queued events exceed 1 MiB is disconnected so a slow connection cannot accumulate
unbounded server memory. Reopen the run from history to inspect its persisted results.

**Caddy**
```
postbox.example.com {
    reverse_proxy postbox:3000 {
        flush_interval -1
    }
}
```

**nginx**
```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;          # live runner progress
    proxy_read_timeout 1h;        # long collection runs
    client_max_body_size 50m;     # file uploads / large imports
}
```

**Traefik**: route to port 3000. No special settings are needed.

## MCP Server (`/api/mcp`)

> Set `POSTBOX_TOKEN` so MCP clients must authenticate. Without auth, anyone who can reach Postbox can use its MCP
> tools (including deletes). Requests from foreign browser origins are always rejected.

Postbox exposes a Streamable HTTP MCP endpoint at `/api/mcp` backed by the same server-side execution engine, collection runner, variable resolver, and SQLite database as the web UI.

**Claude Code**
```bash
claude mcp add --transport http postbox http://localhost:3000/api/mcp
# with POSTBOX_TOKEN set:
claude mcp add --transport http postbox http://localhost:3000/api/mcp --header "Authorization: Bearer $POSTBOX_TOKEN"
```

**Cursor / MCP JSON config**
```json
{
  "mcpServers": {
    "postbox": {
      "url": "http://localhost:3000/api/mcp"
    }
  }
}
```

## Roadmap / TODO

See [ARCHITECTURE.md](ARCHITECTURE.md) for the design. Remaining work:

- [x] Optional single-user auth (`POSTBOX_PASSWORD` / `POSTBOX_TOKEN`)
- [x] MCP server endpoint (`/api/mcp`) so Claude Code / Open WebUI can list, edit, send and run requests
- [ ] Headless CLI runner (Newman-style) reusing `src/core/runner`
- [ ] Scheduled runs (the `schedules` table exists)
- [ ] GitHub Actions workflow (lint, typecheck, test, build, publish image to GHCR)
- [ ] OAuth 2.0 authorization-code + PKCE flow
- [ ] Desktop wrapper

## License

[MIT](LICENSE)
