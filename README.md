# Postbox

A self-hosted, lightweight, open-source alternative to Postman. It runs as a Docker web app on your LAN.
Requests, scripts and collection runs all execute on the server, so you get no CORS problems and
secrets stay on the server.

![Postbox: a request with its JSON response, collection sidebar and environment selector](docs/screenshots/request-response.png)

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/runner-results.png" alt="Collection runner with CSV iteration data and per-request results"></td>
    <td width="50%"><img src="docs/screenshots/light-theme.png" alt="Light theme with a teal accent color"></td>
  </tr>
  <tr>
    <td align="center"><sub>Data-driven collection runs</sub></td>
    <td align="center"><sub>Light theme and any accent color</sub></td>
  </tr>
</table>

## Contents

- [Features](#features)
- [Quick start (Docker)](#quick-start-docker)
- [Usage guide](#usage-guide)
  1. [Send your first request](#1-send-your-first-request)
  2. [Collections, folders and inheritance](#2-collections-folders-and-inheritance)
  3. [Environments and variables](#3-environments-and-variables)
  4. [Scripts and tests](#4-scripts-and-tests)
  5. [Run a collection with iteration data](#5-run-a-collection-with-iteration-data)
  6. [Import, export and code snippets](#6-import-export-and-code-snippets)
  7. [Command palette and keyboard shortcuts](#7-command-palette-and-keyboard-shortcuts)
  8. [Customize Postbox](#8-customize-postbox)
  9. [Command-line runner](#9-command-line-runner)
  10. [Connect Claude Code and other MCP clients](#mcp-server-apimcp)
- [Development](#development)
- [Configuration](#configuration)
- [Running behind a reverse proxy](#running-behind-a-reverse-proxy)
- [Roadmap](#roadmap)

## Features

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
  Runs can also be scheduled with cron expressions.
- **Response viewer**: status, timing breakdown (DNS/TCP/TLS/TTFB/download), size, headers, cookies; Pretty/Raw/Preview with folding and search;
  test results; save as example.
- **Import/export**: Postman v2.0/v2.1 collections and environments, OpenAPI 3 and Swagger 2 (from a file, pasted text or a URL), and cURL
  (paste one into the URL bar). Code snippets for cURL, fetch, Python and PowerShell.
- **Settings**: a searchable Settings page for theme, accent color, fonts, density, layout, editor behaviour and
  defaults for new requests, responses, tabs, the console and the runner.
- **MCP server (`/api/mcp`)**: Streamable HTTP Model Context Protocol endpoint so Claude Code, Open WebUI, Cursor and other MCP clients can inspect workspaces, create/edit collections, folders, environments and requests, execute single requests, run collections with iteration data, and import/export specs.
- **Command-line runner**: `postbox-cli run` runs Postman collections headlessly with the same engine (Newman-style).
- History, cookie manager, command palette (Ctrl+K) and keyboard shortcuts (press `?` in the app).

## Quick start (Docker)

```bash
git clone https://github.com/nkskater/postbox.git
cd postbox
cp .env.example .env && chmod 600 .env   # set POSTBOX_PASSWORD / POSTBOX_TOKEN here
docker compose up -d --build
# open http://<server-ip>:3000
```

Data lives in the `postbox-data` volume (`/data/postbox.db`). To use a bind mount instead, replace the volume with
`./data:/data` and make the directory writable by UID 1001.

> **Try the demo.** Everything in the guide below uses the files in [`docs/demo/`](docs/demo): a collection for the
> free [JSONPlaceholder](https://jsonplaceholder.typicode.com) API, a matching environment and a CSV of test data.
> Import the collection and environment with **Import → File**, then pick **JSONPlaceholder** in the environment
> selector at the top right.

## Usage guide

### 1. Send your first request

1. Press **Alt+T** (or the **+** next to your tabs) to open a new request.
2. Pick a method and type a URL. Query parameters typed in the URL appear in the **Params** tab, and edits there update the URL.
3. Add **Headers**, an **Authorization** method and a **Body** if you need them. For JSON, choose **Body → raw → JSON**;
   **Beautify** formats it.
4. Press **Send** (or **Ctrl+Enter**). Save the request into a collection with **Ctrl+S**.

![A POST request with a JSON body that uses dynamic variables](docs/screenshots/request-body.png)

The response panel shows the status, time and size. Click **Time** for a breakdown of where the time went (DNS,
TCP, TLS, waiting for the first byte, download). Click **Size** to see header and body sizes. **Pretty** formats JSON and XML
with folding; press **Ctrl+F** inside the body to search. **Preview** renders HTML, images and PDFs. **Save as example**
stores the response with the request.

![Response timing breakdown](docs/screenshots/timing.png)

The **Request** tab in the response panel shows exactly what was sent after variables, inherited headers and auth were applied.
Secret values are redacted.

### 2. Collections, folders and inheritance

Collections group requests into folders. Create one with **+** in the sidebar or import one. Each row has a **Run**
button and a **⋯** menu (add request or folder, rename, duplicate, export, delete). Drag rows to reorder them or move them
between folders.

**Edit collection** (or **Edit folder**) opens settings that everything inside inherits:

- **Authorization**: requests set to *Inherit auth from parent* use the nearest folder's or the collection's auth.
- **Headers**: added to every request inside, unless the request sets a header with the same name.
- **Pre-request / Post-response scripts**: run before or after every request inside, outermost first.
- **Variables** (collections only): collection variables.

![Collection settings: bearer auth inherited by every request](docs/screenshots/collection-auth.png)

### 3. Environments and variables

Use `{{name}}` anywhere: URL, params, headers, body, auth fields and scripts. Postbox highlights variables as you
type: **green** when defined and **red** when not. Hover over one to see its current value and where it comes from.
Type `{{` to get autocomplete.

![Variable highlighting with a hover tooltip and an undefined variable in red](docs/screenshots/variables.png)

Variables come from these scopes, highest priority first:

| Scope | Where to edit it |
|---|---|
| Local | `pm.variables.set()` in scripts (lasts one request or one runner iteration) |
| Iteration data | A row of the runner's CSV/JSON/XLSX file |
| Environment | **Environments** in the sidebar; choose the active one at the top right |
| Collection | **Edit collection → Variables** |
| Global | **Environments → Globals** |

Mark sensitive values as **secret**. They are masked in the UI (use the eye button to reveal one) and
redacted from logs, history and the **Request** tab. The 👁 button in the top bar shows every variable in scope.

![Environment editor with a masked secret](docs/screenshots/environment.png)

Dynamic variables produce a new value on each use: `{{$guid}}`, `{{$timestamp}}`, `{{$isoTimestamp}}`,
`{{$randomInt}}`, `{{$randomEmail}}`, `{{$randomFirstName}}` and more.

### 4. Scripts and tests

**Pre-request Script** runs before the request is sent and can change it or set variables. **Post-response Script** runs
afterwards with access to `pm.response`. The Postman `pm.*` API is supported, including `pm.test`, chai-style
`pm.expect`, `pm.sendRequest`, `pm.environment` / `pm.collectionVariables` / `pm.globals` / `pm.variables`,
`pm.iterationData` and `pm.execution.setNextRequest`. Click a **snippet** on the right to insert common code.

![Post-response script with tests and the snippet list](docs/screenshots/scripts.png)

Results appear in the response panel's **Test Results** tab. `console.log()` output appears in the **Console**
(**Ctrl+`**), together with a log line for every request sent.

![Test results](docs/screenshots/test-results.png)

![Console with script output and network log](docs/screenshots/console.png)

Scripts run in an isolated sandbox with no access to the server's files or network, except through `pm.sendRequest`.
They have time and memory limits (`SCRIPT_TIMEOUT_MS`, `SCRIPT_MEMORY_MB`).

### 5. Run a collection with iteration data

Click **Run** on a collection or folder to open the runner. Choose which requests to include, the environment,
iterations, delay and whether to stop on the first failure.

To run the same requests for many inputs, add **Iteration data** (CSV, JSON or XLSX). Each row is one iteration,
and each column becomes a variable for that iteration: a column `userId` is available as `{{userId}}` and
`pm.iterationData.get("userId")`. CSV files are checked on load: a row with more fields than the header,
malformed quotes, or duplicate or missing headers over data are rejected with the row and column at fault, so no
value is silently dropped. Short rows are padded with empty cells and reported as a warning. The CLI and MCP server
apply the same checks. Before running, you can clean the data in the grid:

- edit cells, add or delete rows and columns, and double-click a header to rename it;
- **Trim** whitespace, **Dedupe** rows, **Drop empty** rows;
- **Filter** with free text or `column=value`, `column!=value`, `column~=part`. Only matching rows are run.

![Runner with the demo CSV loaded into the data grid](docs/screenshots/runner-data.png)

Results stream in live. Filter by **passed** or **failed** and expand a row to see each assertion and the response body.
Export a report as **HTML**, **JSON** or **JUnit XML** (for CI dashboards). Past runs are listed in the runner, and
**Schedules** run a collection on a cron schedule. In the demo, the last CSV row deliberately has the wrong name, so one
assertion fails:

![Runner results filtered to the failing assertion](docs/screenshots/runner-results.png)

### 6. Import, export and code snippets

**Import** (top bar or sidebar) accepts Postman v2.0/v2.1 collections and environments, OpenAPI 3 / Swagger 2 (JSON or
YAML) from a file, pasted text or a URL. It also accepts **cURL** commands. You can also paste a cURL command straight into a request's URL bar.

![Import dialog with a pasted cURL command](docs/screenshots/import.png)

Export a collection from its **⋯** menu (Postman v2.1) and an environment from the Environments list. Secret values are
left out of exports. **Code** next to **Save** generates the request as cURL, JavaScript `fetch`, Python `requests` or
PowerShell, with variables resolved or left as `{{placeholders}}`.

![Code snippet generator showing Python](docs/screenshots/code-snippet.png)

### 7. Command palette and keyboard shortcuts

**Ctrl+K** opens the command palette. Search requests, collections and environments, start a run, or jump to any setting.

![Command palette](docs/screenshots/command-palette.png)

| Shortcut | Action |
|---|---|
| Ctrl/⌘ + Enter | Send request |
| Ctrl/⌘ + S | Save request / folder / environment |
| Ctrl/⌘ + K | Command palette |
| Ctrl/⌘ + , | Settings |
| Ctrl/⌘ + B | Toggle sidebar |
| Ctrl/⌘ + ` | Toggle console |
| Alt + T / Alt + W | New tab / close tab |
| Alt + 1…9 | Jump to tab |
| Ctrl/⌘ + F | Search inside an editor or response |
| ? | Show all shortcuts |

### 8. Customize Postbox

Open **Settings** with the gear icon or **Ctrl+,**. Settings are saved on the server, so they follow you to every
browser on your network. Use the search box to find any setting. Changed settings show a dot and can be reset
individually, per section, or all at once. You can also export your settings to a file and import them elsewhere.

- **Appearance**: dark, light or system theme; accent color (presets or any custom color); background tone; true-black
  mode; interface font and size; density; corner radius; reduce motion.
- **Layout**: sidebar on the left or right, rail labels, request and response stacked or side by side.
- **Editor**: code font, size and line height, line numbers, folding, wrapping, tab size, bracket matching, variable autocomplete.
- **Requests / Responses / Tabs / Variables / Console / Collection runner**: defaults for new requests (method,
  timeout, redirects, SSL, cookies), response view and large-body threshold, preview tabs, confirmation before closing unsaved tabs,
  secret display, console limits, and runner options.
- **Server (environment)** shows read-only settings that come from environment variables (see [Configuration](#configuration)).

![Settings: appearance and accent colors](docs/screenshots/settings.png)

### 9. Command-line runner

The Docker image includes `postbox-cli`, a Newman-style runner that uses the same engine without a server or database:

```bash
docker compose run --rm -v "$PWD/docs/demo:/work" postbox \
  postbox-cli run /work/jsonplaceholder.postman_collection.json \
    -e /work/jsonplaceholder.postman_environment.json \
    -d /work/users.csv \
    --reporters cli,junit --reporter-junit-export /work/report.xml
```

Options include `-g` (globals), `-n` (iterations), `--delay`, `--bail`, `--insecure`, `--timeout` and the
`json`, `junit` and `html` reporters. The exit code is non-zero when a request or assertion fails, so it can be used in CI.

## Development

```bash
npm install
npm run dev        # http://localhost:3000, DB at ./data/postbox.db
npm test           # Vitest suites for the engine, sandbox, runner, converters, repository, settings and MCP
npm run lint && npm run typecheck
npm run db:generate  # after changing src/server/db/schema.ts
```

### Regenerating the screenshots

The images in `docs/screenshots/` are produced by `scripts/screenshots.mjs`, which imports the demo files from
`docs/demo/` into a fresh database and captures each screen with Playwright:

```bash
DATABASE_PATH=/tmp/postbox-shots.db npm run dev   # in one terminal (use a new, empty database)
npm run screenshots                               # in another; needs network access for the demo API
```

Set `BASE_URL` if the app is not on `http://localhost:3000`, and `CHROMIUM_PATH` to use a specific Chrome or
Chromium binary (otherwise run `npx playwright-core install chromium` once).

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

### Container resource limits

Docker Compose limits the entire running app, including the web server, request execution,
script sandboxes and collection runs. Set these Compose variables in `.env`:

| Variable | Default | Description |
|---|---|---|
| `POSTBOX_MEMORY_LIMIT` | `1g` | Total container memory, using Docker byte units such as `512m` or `2g` |
| `POSTBOX_CPU_LIMIT` | `2.0` | CPU quota in cores; fractional values such as `0.5` are supported |
| `POSTBOX_PIDS_LIMIT` | `256` | Maximum total processes and threads in the container |

These [Compose service limits](https://docs.docker.com/reference/compose-file/services/)
apply at runtime, including `docker compose run postbox postbox-cli ...`; they do not limit image builds
or `npm run dev` on the host. `SCRIPT_MEMORY_MB` and `SCRIPT_TIMEOUT_MS` still limit each script separately.
The container budget also covers Node.js, QuickJS/WASM overhead, response bodies and concurrent runs,
so keep it above the per-script allowance and increase it for large responses or many simultaneous runs.
Reaching the memory limit can cause Docker to kill the app; reaching the CPU quota throttles it.
The PID limit includes Node.js worker threads, so setting it too low can prevent startup or scripts from running.

After editing `.env`, apply the limits with `docker compose up -d`. Check the resolved configuration with
`docker compose config --quiet` and inspect runtime use with `docker stats postbox`.

### Authentication

Set either or both of these to require authentication for the UI and every API route, including `/api/mcp`.
`/api/health` and `/login` stay public.

- `POSTBOX_PASSWORD`: enables the `/login` page, which issues a signed, HTTP-only session cookie (default 30 days).
- `POSTBOX_TOKEN`: accepted as `Authorization: Bearer <token>` for scripts and MCP clients (and on the login form).

Put them in the git-ignored `.env` file (see `.env.example`), not in `docker-compose.yml`, which is tracked in git.
Anyone with Docker access on the host can still read them with `docker inspect`. Changing either value signs everyone out. With neither set, Postbox is open. Only run it that way on a trusted network.

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

Ask your assistant things like *"list my Postbox collections"*, *"send the Get user request with userId 3"* or
*"run the JSONPlaceholder Demo collection with this CSV and summarise the failures"*.

## Roadmap

See [ARCHITECTURE.md](ARCHITECTURE.md) for the design. Planned work is tracked as stories in Jira; highlights:

- [x] Optional single-user auth (`POSTBOX_PASSWORD` / `POSTBOX_TOKEN`)
- [x] MCP server endpoint (`/api/mcp`)
- [x] Headless CLI runner (`postbox-cli`)
- [x] Scheduled runs
- [x] GitHub Actions CI and multi-platform images on GHCR
- [x] Settings page (appearance, layout, editor and behaviour defaults)
- [ ] Server-side settings: script limits, global default headers, User-Agent
- [ ] Settings: history retention, full backup/restore, notifications, locale
- [ ] Settings: outbound proxy, CA/client certificates, MCP controls, shortcut rebinding
- [ ] OAuth 2.0 authorization-code + PKCE flow
- [ ] Desktop wrapper

## License

[MIT](LICENSE)
