# Management API (v1)

Postbox exposes its workspace content over HTTP so scripts, CI jobs and other tools can manage it. This page is the
contract; the machine-readable form is [`docs/openapi/postbox-management-v1.json`](openapi/postbox-management-v1.json)
(OpenAPI 3.1), also served by every instance at `GET /api/openapi.json` (no credentials needed).

It covers workspaces, collections and folders, requests, environments and variables, runs, schedules, outbound
webhooks and settings. Other routes in the app (live connections, importers, mocks, datasets, administration) are
used by the web app and are **not** part of v1; they may change without notice until a later version documents them.

## Calling it

```sh
curl -H "Authorization: Bearer $POSTBOX_TOKEN" "$POSTBOX_URL/api/workspaces"
```

Tokens (`pbx_…`) are created in **Settings → API keys**; service accounts get their own. Browser sessions use a cookie
and are meant for the web app. Bodies are JSON (`Content-Type: application/json`), timestamps are Unix milliseconds
and ids are opaque strings. Every response carries `Postbox-API-Version: 1`.

Reusable clients live in [`examples/management-api`](../examples/management-api): a dependency-free JavaScript client
and a curl script. To generate a typed client in another language, feed the OpenAPI file to your generator of choice.

## Permissions

Each operation requires one workspace action. Workspace roles grant actions (viewer: read; editor: read, run and
write; owner and admin: also manage), and an API key can only narrow what its owner may do:

| Key scope | Actions it allows                             |
| --------- | --------------------------------------------- |
| `read`    | read                                          |
| `run`     | read, run                                     |
| `write`   | read, run, write                              |
| `full`    | read, run, write, manage (members, webhooks…) |

The document marks every operation with `x-postbox-access` (and `x-postbox-key-scope`). Someone who cannot see a
workspace gets `404`, exactly like a missing resource, so ids cannot be probed. A caller who can see it but lacks
the permission gets `403`.

## Errors

Failures use the HTTP status and a JSON body:

```json
{
  "error": "Invalid input",
  "issues": [{ "path": ["name"], "message": "Too small: expected string to have >=1 characters" }]
}
```

| Status | Meaning                                                                 |
| ------ | ----------------------------------------------------------------------- |
| 400    | Invalid input (`issues` lists the problems for schema errors)           |
| 401    | Missing or invalid credentials                                          |
| 403    | The credentials lack the permission or key scope                        |
| 404    | Not found, or not visible to the caller                                 |
| 409    | State conflict (for example replaying a delivery that is still pending) |
| 413    | Body larger than `API_BODY_LIMIT_MB` (default 25)                       |
| 429    | The run queue or a rate limit is full; retry later                      |

Branch on the status. The `error` text is for people and may be reworded.

## Lists and pagination

List endpoints return a JSON array. They are bounded rather than cursor-paginated: `GET /api/runs` returns the 50 most
recent runs, and `GET /api/webhooks/{id}/deliveries` accepts `limit` (1–200, default 50) and `status`. Everything else
returns the complete set for the workspace, which is small by design. If a list ever needs cursors it will be added
in a backwards-compatible way (a new optional parameter and header), never by changing the array shape.

## Idempotency and retries

Postbox does not accept an `Idempotency-Key` header. Retry according to the method:

- `GET`, `PUT` and `DELETE` are safe to repeat. A repeated `DELETE` answers `404`.
- `PATCH` operations set fields to the values you send, so repeating them is harmless too.
- `POST` operations that create something (workspaces, folders, requests, environments, schedules, webhooks) create
  another one if repeated, and runs, test events, replays and secret rotation have side effects. After a network
  failure, list first to see whether the first attempt landed.

The OpenAPI file records this per operation as `x-postbox-idempotent`.

## Running collections

`POST /api/runs` answers with **newline-delimited JSON events** (`application/x-ndjson`): `start`, `iteration`,
`request`, `result`, `log`, and finally `done`. Problems with the references (unknown folder, queue full) are returned
as ordinary JSON errors before the stream begins. The run is stored and continues even if you disconnect; find it
again with `GET /api/runs`.

## Versioning and compatibility

The API version is the major number in `Postbox-API-Version` and in the file name (`…-v1.json`). Routes keep their
`/api/…` paths; a future incompatible version will be served alongside v1 under `/api/v2/…` for at least one minor
release of Postbox before v1 is retired, and the retirement is announced in the changelog.

**Within v1 we only make additive changes:** new endpoints, new optional request fields, new response fields, new
enum values in responses and new event types. **Clients must therefore ignore unknown response fields** and treat
unknown enum values as "other".

**Breaking changes need v2:** removing or renaming a field, endpoint or status code, making an optional input
required, tightening validation, or changing a field's meaning or type.

The document's `info.version` follows semver: minor for additions, patch for wording. A change to the contract
fails `tests/management-api.test.ts` until `npm run openapi:generate` is run and the regenerated file is committed,
so the checked-in file always matches the code. The same test sends every documented request to the real handlers
and validates the real responses against these schemas, and fails if a route is added to the app without being
either documented or classified as outside v1.

## Not in v1 yet

Datasets, mocks, script packages, request examples, documentation, catalogs, audit and usage queries, members and
invites, imports and exports. They are exposed by the app and the CLI today and will be added to the contract
(and the file regenerated, as a minor version) as each is stabilised.
