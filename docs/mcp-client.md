# External MCP client

Open **MCP client** in the sidebar to connect to a Streamable HTTP MCP server.
This is separate from Postbox's existing `/api/mcp` server.

1. Enter the HTTP(S) endpoint and optional headers as a JSON array:
   `[{"key":"Authorization","value":"Bearer {{mcpToken}}"}]`.
2. Select the environment in the top bar, then connect. Global and environment
   variables resolve on the server. Unresolved variables prevent connection.
3. Inspect the negotiated server name/version, capabilities and instructions.
   Browse tools, resources, resource templates and prompts using the list buttons.
   Paginated lists offer **Next page**.
4. Select a discovered item. Inspect its tool input schema or prompt arguments,
   fill the operation target/arguments, then choose **Run operation**. Selecting
   an item does not execute it. Resource templates require a concrete resource URI.
5. Name and save a call to retain the endpoint, header templates and operation.
   Reopen it later, connect, then run with the current environment's values.
   **Disconnect** terminates the remote session and closes local streams.

Tool arguments are JSON objects; prompt arguments must be string-valued JSON
objects. Nested string values support `{{variables}}`. Variables resolve from the
snapshot captured at connection time. Reconnect after changing variable values.
Saved calls belong to the current workspace. Editors can save/update/delete and
run; viewers can browse saved templates but cannot connect or execute. Updates
use revisions to prevent overwriting another user's changes.

Saved sensitive headers/query values/argument fields must use whole variable
references (`Bearer {{token}}` and `Basic {{encodedCredentials}}` are supported
for authorization headers). Raw ad-hoc credentials may be used for a connection
but cannot be saved. Keep credentials in secret variables so returned echoes can
be redacted. Call forms and connection credentials are not written to browser
local storage. Remote content, schemas and instructions display as text/JSON;
Postbox does not execute remote HTML, follow resource links or fetch embedded
images. A tool's `isError` result remains distinct from a transport error.

## REST automation

These protocol endpoints are outside the v1 management OpenAPI contract and use
the same Postbox login/API token and workspace authorization as other protocols.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/mcp-client/calls?workspaceId=ID` | List saved calls |
| POST | `/api/mcp-client/calls` | Create `{workspaceId,name,connection,action}` |
| GET | `/api/mcp-client/calls/ID` | Get a saved call and revision |
| PATCH | `/api/mcp-client/calls/ID` | Replace `{name,connection,action,expectedRevision}` |
| DELETE | `/api/mcp-client/calls/ID` | Delete a saved call |
| POST | `/api/mcp-client/sessions` | Connect `{workspaceId,environmentId?,connection}` |
| POST | `/api/mcp-client/sessions/ID` | Execute `{action}` |
| DELETE | `/api/mcp-client/sessions/ID` | Disconnect |

Connection shape:

```json
{"url":"{{mcpUrl}}","headers":[{"key":"Authorization","value":"Bearer {{mcpToken}}"}],"timeoutMs":15000}
```

Connect returns a local opaque `id`, server metadata, negotiated protocol version,
capabilities and optional instructions. The remote session identifier stays on
the server. Sessions belong to the connecting user; another workspace editor
cannot use or close them. Run authorization is rechecked for every operation,
including after membership revocation. A run-scoped API token can connect/run;
a write-scoped token is needed to change saved calls. The existing MCP server
and its tool inventory are unchanged.

Supported action shapes:

```json
{"type":"tools/list","cursor":"optional-server-cursor"}
{"type":"tools/call","name":"echo","arguments":{"value":"{{message}}"}}
{"type":"resources/list"}
{"type":"resources/templates/list"}
{"type":"resources/read","uri":"example://resource"}
{"type":"prompts/list"}
{"type":"prompts/get","name":"greet","arguments":{"name":"Ada"}}
```

Example connection using a Postbox API token (the external credential resolves
from the selected environment):

```sh
curl -X POST http://localhost:3000/api/mcp-client/sessions \
  -H 'Authorization: Bearer POSTBOX_TOKEN' -H 'Content-Type: application/json' \
  -d '{"workspaceId":"WORKSPACE_ID","environmentId":"ENVIRONMENT_ID","connection":{"url":"{{mcpUrl}}","headers":[{"key":"Authorization","value":"Bearer {{mcpToken}}"}]}}'
curl -X POST http://localhost:3000/api/mcp-client/sessions/SESSION_ID \
  -H 'Authorization: Bearer POSTBOX_TOKEN' -H 'Content-Type: application/json' \
  -d '{"action":{"type":"tools/list"}}'
curl -X DELETE http://localhost:3000/api/mcp-client/sessions/SESSION_ID \
  -H 'Authorization: Bearer POSTBOX_TOKEN'
```

## Transport, diagnostics and limits

Only Streamable HTTP is supported; stdio, legacy separate SSE endpoints and
interactive OAuth discovery/login are not part of this adapter. Supply a valid
bearer/basic/API-key header or acquire a token separately. The client advertises
no sampling/elicitation capabilities and runs no local commands.

Each connection uses the existing outbound proxy, custom CA/mTLS configuration,
and host allow/deny policy. Direct DNS answers are checked before connecting;
redirects cannot leave the configured origin. TLS verification stays enabled.
JSON and SSE POST responses are supported. Optional GET notification streams are
bounded and not presented as a separate notification log; automatic reconnect is
disabled. A disconnected session must be reconnected explicitly. Requests do not
retry tool calls automatically.

Safe diagnostic prefixes identify `auth`, `policy`, `transport`, `protocol`,
`timeout` and `limit` failures without returning remote error bodies or credential
values. External authentication failures return HTTP 502 with `auth:` so they do
not sign you out of Postbox. Policy failures return 403, size failures 413 and
timeouts 504. Tool results can independently contain `isError: true`.

Limits: 50 concurrent/pending sessions per process, 10 per user, one active
operation per session, 10 minutes idle and 30 minutes maximum lifetime. UI unmount,
workspace/environment changes, disconnect and rejected workspace authorization
close sessions. Cleanup attempts remote DELETE (servers may decline it) and
always aborts local requests/streams. Process restarts clear in-memory sessions.
Timeout defaults to 15 seconds and is configurable from 100 ms to 60 seconds via
the connection API. HTTP request bodies are capped at 1 MiB, each response stream
at 2 MiB, returned operation results and server metadata at 1 MiB. Call arguments
are capped at 256 KiB, 32 nesting levels and 10,000 JSON nodes. There are at most
500 saved calls per workspace, each at most 256 KiB. Results are not persisted.

Tool schemas are inspected as data; Postbox does not compile remote output schemas
into host-side validators. Returned tool content remains available for inspection.
Session credential redaction is bounded to 5,000 distinct values and 2 MiB.
