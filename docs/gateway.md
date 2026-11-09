# Managed API, LLM and MCP gateway

The optional gateway exposes native HTTP routes backed by Postbox's credential broker. Consumers authenticate to Postbox and present an approved broker grant; provider credentials stay in the encrypted workspace vault. API keys with `run`, `write` or `full` scope can invoke routes when the account has workspace run permission and an approved provider grant. Read-only keys and viewers cannot invoke them.

## Enable and configure

1. Configure Postbox user accounts or recovery authentication. The gateway refuses serving in authentication-disabled mode.
2. Set `GATEWAY_ENABLED=true` on the server. Docker Compose reads it from `.env`; it defaults to false. Management remains available while serving is disabled.
3. Open **Gateway** in the sidebar. The management page opens separately so request drafts stay open.
4. Select a workspace and add a provider with a base URL and vault secret. Supply a new credential or reference an existing workspace secret. Bearer, named header, Basic and query injection are supported. New credentials are restricted to the provider host. Existing broker APIs and grants can be reused.
5. Add an API, LLM or MCP route. Select the provider, optionally set an upstream path prefix, review policy and quotas, then enable the route. New routes default to disabled.
6. Grant a workspace consumer access to the provider. Grants may be restricted to a particular Postbox API key ID, method set, path prefixes and expiry through the broker APIs. The UI grants 24-hour access and supports approval/revocation. Editors can request access for owner approval.

Owners manage configuration; workspace members can inspect configuration and recent traces. Provider credentials are write-only. A token-bound grant works only with that key and consumer. Revoking a grant or key, disabling an account/provider/route, or expiring a grant rejects subsequent calls. Active calls end on client cancellation, response byte limit or total deadline.

## Native HTTP endpoint

Each route has `/api/gateway/<route-id>`. Append a path under the registered provider's base URL and the route's upstream prefix. Supply both headers:

```sh
curl "$POSTBOX_URL/api/gateway/$ROUTE_ID/chat/completions" \
  -H "Authorization: Bearer $POSTBOX_API_TOKEN" \
  -H "X-Postbox-Grant: $GRANT_ID" \
  -H "Content-Type: application/json" \
  -d '{"model":"local-model","messages":[{"role":"user","content":"Hello"}],"stream":true}'
```

`POSTBOX_API_TOKEN` is the consumer's Postbox token. It is never forwarded to the provider. Cookies, connection headers, caller authentication and the grant header are excluded from upstream requests. Only policy-allowlisted headers are forwarded. Provider credentials are injected after grant and path validation. Redirects are rejected; credentials cannot be redirected to another host. Host allow/deny rules, resolved-IP checks, outbound proxies, custom CAs and mTLS profiles apply.

For OpenAI-compatible SDKs, use the route URL as `base_url`, the consumer Postbox token as `api_key`, and `X-Postbox-Grant` as a default header. With a provider base URL ending in `/v1`, leave the upstream prefix empty. With a provider base URL containing only the origin, set the prefix to `/v1`.

For MCP Streamable HTTP, point the client at the route URL, set the same authentication/grant headers and configure the upstream prefix for the provider's endpoint, such as `/mcp`. Current MCP method/name metadata and `Mcp-Param-*` headers are forwarded by default, and standard header/body mismatches are rejected. Older protocol session ID and last-event ID headers are also supported. Legacy sessions are bound to the route and grant that created them; only hashes are retained, for up to 24 hours and at most 1,000 sessions per workspace. A copied session ID cannot be used through another grant. Add `DELETE` to allowed methods when the client terminates sessions through HTTP DELETE. MCP methods and tool names are checked before forwarding, including every message of a legacy batch. Browser origins use the existing MCP origin allowlist. See the [current Streamable HTTP transport specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http).

## Policy and quotas

Common controls appear in the route form. Advanced policy JSON exposes every option:

| Field | Behavior |
| --- | --- |
| `methods`, `pathPrefixes` | Allowed client methods and path prefixes; broker/provider/grant restrictions also apply. |
| `forwardHeaders` | Explicit header allowlist; credential and connection headers remain blocked. |
| `allowedModels` | LLM model allowlist; empty permits any model. |
| `maxOutputTokens` | Rejects larger requested budgets and supplies a default budget when omitted. Supports `max_tokens`, `max_completion_tokens`, `max_output_tokens`; Responses requests use `max_output_tokens`. Embedding/model endpoints do not receive an output budget. |
| `allowedMcpMethods`, `allowedMcpTools` | MCP JSON-RPC method and tool-call restrictions; an empty tool list permits all tools. Discovery responses may list other provider tools, but calls remain restricted. |
| `allowStreaming` | Allows LLM streaming requests and upstream SSE responses. |
| `requestsPerMinute`, `requestsPerDay` | Route-wide request quotas in UTC minute/day windows, persisted in SQLite; rejected excess calls return 429 and `Retry-After`. Forwarding attempts consume quota even when the upstream fails. |
| `timeoutMs` | Total upstream deadline, including streaming (default 60 seconds, at most 5 minutes). |
| `maxRequestBytes`, `maxResponseBytes` | Bounded uploads and response streams; requests are buffered within the upload limit. Binary bodies are preserved. Compressed responses are decoded and bounded before delivery. |

Output credentials are redacted as bytes, including across stream chunk boundaries. Redaction may briefly hold a suffix as long as a credential variant. Responses are streamed with backpressure; client disconnect/cancellation closes upstream work. Exceeding a response limit after headers have been sent closes the stream and records the failure; a partial response must not be treated as complete.

## Status, traces and automation

Gateway health reports configuration readiness and recent observed outcomes. Refreshing status performs no upstream probe. SQLite retains the last 1,000 workspace traces; the page shows the most recent 200. Traces and gateway call audit events contain route/consumer identifiers, method, status, reason code, duration and byte counts. They exclude payloads, full URLs, query values, headers and credential values.

Management endpoints use the caller's usual Postbox session or API token:

- `GET /api/gateway?workspaceId=...`: providers, routes, visible consumer grants, quotas, health and traces.
- `POST /api/gateway/providers`: `{workspaceId,name,baseUrl,secretName,injection,credentialValue?}`. Supplying a value creates an encrypted, host-restricted vault secret atomically with the provider.
- `POST /api/gateway/routes`: `{workspaceId,name,apiId,kind,upstreamPrefix?,enabled?,policy?}`.
- `GET`, `PUT`, `DELETE /api/gateway/routes/{id}`: inspect, replace configuration, delete. PUT accepts configuration fields only; counters and IDs are read-only.
- `POST /api/gateway/providers/{id}/grant`: `{consumerId?,tokenId?,expiresInSec?}`; omitted consumer selects the caller.
- Existing `/api/broker/apis/{id}` and `/api/broker/grants/...` endpoints update/disable providers, narrow grants, approve requests and revoke access.

There is no anonymous gateway token or separate identity store. Back up the database and vault key together using the documented vault backup procedure. Provider deletion also removes dependent routes; retained trace metadata keeps a deleted-route marker.
