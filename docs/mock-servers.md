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
No request scripts execute and the server makes no outbound API calls.

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

| Method and path                | Behavior                                                                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/mocks?workspaceId=…` | List settings and example counts, without keys.                                                                                       |
| `POST /api/mocks`              | `{workspaceId,folderId,name,enabled?,public?,matchQuery?,matchBody?,delayMs?,status?,headers?}`; returns snapshot and one-time `key`. |
| `GET /api/mocks/:id`           | Read settings and sanitized example snapshot.                                                                                         |
| `PATCH /api/mocks/:id`         | Change name, enabled/public flags, matching and response settings.                                                                    |
| `DELETE /api/mocks/:id`        | Delete endpoint and logs.                                                                                                             |
| `POST /api/mocks/:id/refresh`  | Explicitly capture the latest saved examples.                                                                                         |
| `POST /api/mocks/:id/key`      | Rotate credential; returns one-time `key`.                                                                                            |
| `GET /api/mocks/:id/logs`      | Last 100 metadata entries.                                                                                                            |
| `DELETE /api/mocks/:id/logs`   | Clear logs.                                                                                                                           |
| `GET /api/mocks/:id/export`    | Sanitized JSON snapshot without keys or logs.                                                                                         |

Header rows use `{key,value,enabled}`. Status `null` uses the selected example.
MCP provides `list_mocks`, `get_mock`, `create_mock`, `update_mock`, `refresh_mock`,
`rotate_mock_key`, `delete_mock`, `export_mock`, `list_mock_logs`, and
`clear_mock_logs`. Existing-resource tools use `mockId`; creation takes the same
fields as REST. Tool discovery advertises all schemas.
