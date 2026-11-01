# Example-backed mock servers

Save response examples on the requests in a collection, then open **Mocks** in the
sidebar and choose **New mock**. Select the collection and create the endpoint.
The panel shows its `/mock/<id>` base path and a one-time private key. Append the
original API path and query, and send the key in `x-postbox-mock-key`.

Mocks are private by default. Copy the key when creating or rotating it; it cannot
be retrieved afterward. Rotation immediately invalidates the previous key. App
sessions and API tokens do not substitute for the mock key. **Share publicly
without a mock key** explicitly permits anonymous calls to the endpoint. Review
its response examples before sharing. Disable or delete a mock to stop serving it.
Workspace viewers may inspect settings, snapshots, logs and sanitized exports;
editors/owners may create, change, refresh, rotate keys or delete endpoints.

The endpoint uses a snapshot of sanitized saved examples. Later collection edits
do not change it until **Refresh examples** is selected. **Source examples**
opens the existing example editor. Refresh fails if an example has an omitted or
truncated response, unsupported request-body matching, or invalid URL. Source
folder deletion does not delete an already captured snapshot; refresh then fails.
No request scripts execute and the server makes no outbound API calls; the only code a mock runs is its own
[handlers](#handlers), in a sandbox. Partial updates (`PATCH`) change only the fields they name.

## Matching and response selection

Method and path always match. Literal path segments outrank whole-segment
`:parameter` or `{{variable}}` segments; parameter values must be nonempty and may
not contain encoded slashes. Equal matches use saved collection/example order.
Trailing slashes are significant. Hosts are ignored. A leading `{{baseUrl}}` is
accepted; variables are not resolved from workspace secrets.

By default query parameters match exactly, including duplicate values, independent
of order. JSON request bodies compare structurally, ignoring object key order;
other bodies compare as exact text. Empty, raw and URL-encoded saved request
bodies are supported. Disable query/body matching explicitly when desired. A
saved request's enabled Params table is used when present. HEAD and OPTIONS
require examples with those methods. Unsupported methods return 405.

Choose a matching example with `x-mock-response-id`, `x-mock-response-name`, or
`x-mock-response-code`. These selectors still require method/path/query/body
matching. No match returns a JSON 404 error. The example supplies response status,
headers and exact UTF-8 or binary bytes. Settings can override status (200–599),
headers, and delay (0–30,000 ms). HEAD and 204/205/304 responses have no body.
Responses cannot set app cookies or override the mandatory no-store, nosniff,
referrer and sandbox content security policies. HTML responses cannot execute
scripts, access the app origin, frame the app, or register service workers.
Cross-origin browser use requires appropriate configured response headers and an
OPTIONS example for preflight; credentials are never added automatically.

## Failure simulations

Select a mock and use **Failure simulations** (or `scenarios` in the REST/MCP settings) to make an
endpoint misbehave on purpose. Rules are fixed and deterministic: no scripts run. They apply to every
request, including paths that match no example, and are evaluated in order.

| Type        | Behavior                                                                                             |
| ----------- | ---------------------------------------------------------------------------------------------------- |
| `failFirst` | The first `count` requests of a session answer `status`, then the mock serves normally.              |
| `failEvery` | Every `every`th request (2 or more) answers `status`.                                                |
| `error`     | Every matching request answers `status` (400–599).                                                   |
| `sequence`  | One status per request in order (`0` serves the saved example); `repeat` starts over.                |
| `rateLimit` | `limit` requests per `windowSeconds`, then `status` (default 429) with `Retry-After`.                |
| `delay`     | Adds `ms` (1–30,000) of latency. Latency from several rules, plus the mock's own, is capped at 30 s. |

Each rule may carry `match: { method?, path? }` (paths accept whole-segment `:parameters`), a custom
`body` (up to 8 KiB) and `contentType` for the failure response, and can be switched off with
`enabled: false`. A simulated failure responds with a JSON body `{"error":"Simulated failure","scenario":…}`
unless you give one, and with `X-Postbox-Mock-Scenario` naming the rule. A failing rule ends the list: later
rules do not see that request, so their counters only count requests that reached them. Rate-limit rules also
add `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset` to responses they allow. At most 50
rules per mock. Workspace secrets are masked in simulated bodies like everything else a mock serves.

**Sessions.** Counters are kept per session, so parallel test runs do not disturb each other. Send
`x-mock-session: <name>` (1–64 letters, digits, `.`, `_` or `-`); requests without it share the `default`
session. Every response carries `X-Postbox-Mock-Session`. Counters are held in memory: they restart with the
server, when the rules are changed, and after a reset, and idle sessions expire after an hour (at most 200
sessions per mock, least recently used first). Rate-limit windows run on the server clock, starting at a
session's first request in the window, so a reset makes a run reproducible. Reset with
`POST /api/mocks/:id/reset` and body `{"session":"name"}` (omit `session` to reset all), the **Reset counters**
button, or the MCP tool `reset_mock_state`.

## Handlers

A handler is sandboxed JavaScript that computes a response from the request, a per-session `state` object and the
matched example. Open a mock and use **Handlers** (or `handlers` in the REST/MCP settings). The code is the body of
`function (req, state, example, ctx)`:

```js
const n = state.get("orders", 0) + 1;
state.set("orders", n);
if (n > 3) return { status: 429, headers: { "Retry-After": "5" }, json: { error: "slow down" } };
return {
  status: 201,
  json: { id: `ord_${n}`, qty: req.json.qty, price: example && JSON.parse(example.body).price },
};
```

| Name      | Contents                                                                                                                |
| --------- | ----------------------------------------------------------------------------------------------------------------------- |
| `req`     | `method`, `path`, `query` (first value) and `queryAll`, `headers` (lowercase), `body` (text), `json` (parsed or `null`) |
| `example` | The matched saved example `{id, name, status, headers, body}` (`body` is `null` for binary), or `null`                  |
| `state`   | `get(key, fallback)`, `set(key, value)`, `delete`, `has`, `keys`, `clear`; JSON values only                             |
| `ctx`     | `count` (this handler's 1-based call number in the session) and `session`                                               |

Return `{ status?, headers?, contentType?, body?, json? }` (`body` or `json`, not both), or nothing to serve the
matched example as usual. A response with only `status` and `headers` modifies the example; one with `body` or `json`
replaces it (the example's headers are then not used). A handler can also answer paths that no example matches. Each
handler has an optional `match: { method?, path? }` (whole-segment `:parameters`); the first enabled handler that
matches runs, **after** failure simulations (which still win) and never for a request they already failed.

**Sandbox.** Every call runs in a fresh QuickJS (WASM) context: no network, files, timers, modules, `process` or other
host objects, and nothing carries over except `state`. Limits: 1 s of run time, 8 MiB of memory, 256 KiB call stack,
16 KiB of code per handler, 20 handlers per mock, 256 KiB of output, 50 log lines, and for `state` 100 keys
(`[A-Za-z0-9_.:-]`, up to 64 characters) and 16 KiB in total. A handler that fails, throws, runs too long or returns
something invalid answers **500** with `{"error":"Mock handler failed","handler":…,"detail":…}` and
`X-Postbox-Mock-Handler`; its state changes are discarded. Time is checked between JavaScript operations, so a native
loop can overshoot the limit by a few seconds before it is stopped.

**Deterministic.** `Math.random()` is seeded from the mock, session, handler and call number, and `Date` is a virtual
clock (2020-01-01T00:00:00Z plus one second per call). Replaying the same requests in a fresh session (after a reset)
gives identical responses.

**State and sessions.** State is kept per session (`x-mock-session`, as for failure simulations) in memory, bounded to
200 sessions per mock and expiring after an hour idle. Requests of one session run one at a time, so no update is lost;
sessions run in parallel and never see each other's state. Changing a mock's handlers, `POST /api/mocks/:id/reset`, the
**Reset counters** button, `reset_mock_state` and `postbox mock reset` clear it. `GET /api/mocks/:id/state`
(`get_mock_state`, **View session state**) shows what is held.

**Privacy.** Handlers never see `Authorization`, `Cookie`, `Proxy-Authorization` or `x-postbox-mock-key`, and have no
access to workspace secrets or variables. Workspace secrets are masked in handler responses, errors and exports like
everything else a mock serves. Handler code is part of mock exports and application backups; backups made without
secrets scrub it like other mock content.

**Test console.** The handler editor can run unsaved code against a made-up request, a starting `state` and a call
number, and shows the response, resulting state, `console.log` output and timing. Nothing is stored.
`POST /api/mocks/:id/handlers/test` (`test_mock_handler`, `postbox mock handler test`) does the same.

## Command line

The CLI manages mocks on a running Postbox server (it has no server of its own):

```sh
postbox mock launch <collectionId> -w <workspace> --name Pets [--public] [--handlers handlers.json]
postbox mock handler set <mockId> quote.js --method POST --path /quotes/:id   # add or replace one handler
postbox mock handler test <mockId> quote.js --path /quotes/7 --state '{"n":2}' --count 3
postbox mock handler delete <mockId> quote
postbox mock reset <mockId> --session ci-42      # omit --session for all sessions
postbox mock state <mockId>
```

`launch` prints the mock's URL and its one-time key (send it as `x-postbox-mock-key`), so a test pipeline can create a
mock, reset it between runs and delete it afterwards.

## Privacy and limits

Known workspace secrets and credential-like fields are redacted from snapshots,
served responses and mock exports. Values are not interpolated into responses.
Secret marking is checked again at read/serve time. A mock export contains the
selected settings and snapshot; it omits the private key/hash and request logs.
Keys are stored only as SHA-256 hashes. Full credential-inclusive application
backups retain the hash; backups without secrets scrub snapshots and restore
mocks disabled/private with new unusable key hashes. Rotate a key before enabling
such a restored endpoint. Legacy backups without mocks remain supported.

Request logs retain at most 100 entries per endpoint: method, matching path
**template** (or `[unmatched]`), response status, example reference, timestamp and
duration. Incoming headers, query values, bodies and unmatched paths are never
stored. Failed authentication is not logged. Logs are excluded from application
backups and can be cleared separately. Inbound bodies are limited to 1 MiB;
snapshots to 1,000 examples and 20 MiB. Existing saved-example limits also apply.

## REST and MCP

Management requires normal Postbox authentication and workspace permissions.
Invocation `/mock/<id>/<path>` independently enforces private-key/public settings,
even when application login is enabled.

| Method and path                     | Behavior                                                                                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/mocks?workspaceId=…`      | List settings and example counts, without keys.                                                                                                  |
| `POST /api/mocks`                   | `{workspaceId,folderId,name,enabled?,public?,matchQuery?,matchBody?,delayMs?,status?,headers?,scenarios?}`; returns snapshot and one-time `key`. |
| `GET /api/mocks/:id`                | Read settings and sanitized example snapshot.                                                                                                    |
| `PATCH /api/mocks/:id`              | Change name, enabled/public flags, matching and response settings.                                                                               |
| `DELETE /api/mocks/:id`             | Delete endpoint and logs.                                                                                                                        |
| `POST /api/mocks/:id/refresh`       | Explicitly capture the latest saved examples.                                                                                                    |
| `POST /api/mocks/:id/key`           | Rotate credential; returns one-time `key`.                                                                                                       |
| `GET /api/mocks/:id/logs`           | Last 100 metadata entries.                                                                                                                       |
| `DELETE /api/mocks/:id/logs`        | Clear logs.                                                                                                                                      |
| `POST /api/mocks/:id/reset`         | Restart failure-simulation counters and handler state: `{session?}`; returns `{ok,cleared}`.                                                     |
| `POST /api/mocks/:id/handlers/test` | Run a handler without storing anything: `{handlerId?                                                                                             | code?, request?, state?, count?, session?}`. |
| `GET /api/mocks/:id/state`          | Per-session handler state and call counts.                                                                                                       |
| `GET /api/mocks/:id/export`         | Sanitized JSON snapshot without keys or logs.                                                                                                    |

Header rows use `{key,value,enabled}`. Status `null` uses the selected example.
MCP provides `list_mocks`, `get_mock`, `create_mock`, `update_mock`, `refresh_mock`,
`rotate_mock_key`, `delete_mock`, `export_mock`, `list_mock_logs`, `clear_mock_logs`, and
`reset_mock_state`, `test_mock_handler` and `get_mock_state`. Existing-resource tools use `mockId`; creation takes the same
fields as REST. Tool discovery advertises all schemas.
