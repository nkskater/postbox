# Incoming webhooks

An **incoming webhook listener** is a URL on your Postbox server that a provider (GitHub, Stripe, a CI system, your own
service) can call. Postbox stores what arrives so you can inspect it, answers with a response you choose, can verify
the provider's signature, and can forward or replay the request to another address.

Owners and administrators manage listeners in **Settings → Workspace sharing → Incoming webhooks**, or over the REST
API under `/api/hook-listeners` (requires the `manage` action, which an API key needs the `full` scope for).

## The URL

Creating a listener returns its URL once: `https://your-server/hook/hk_…`. The token in it is the only credential, so
anyone who has the address can send requests to that listener. Postbox keeps only a hash of the token; if you lose
the URL, use **New URL** (rotate), which stops the old one working immediately. Requests to any path below the URL
(`/hook/hk_…/orders/7?x=1`) reach the same listener and the path and query are recorded.

Unknown, malformed and revoked tokens all answer the same `404`, so tokens cannot be probed.

## Status

| Status    | Behaviour                                                        |
| --------- | ---------------------------------------------------------------- |
| `active`  | Receives requests.                                               |
| `paused`  | Answers `503` with `Retry-After`; nothing is stored. Reversible. |
| `revoked` | Answers `404`. Permanent; stored requests stay for inspection.   |

## Verification

Choose how to check that a request came from the provider. The secret is write-only: it is never listed or returned.

| Type          | Checks                                                                                                                                  |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `none`        | Nothing. Anyone with the URL can post.                                                                                                  |
| `token`       | A header equals the shared secret (for example GitLab's `X-Gitlab-Token`).                                                              |
| `hmac`        | HMAC-SHA256 of the raw body in a header, hex or base64, with an optional prefix. GitHub is `X-Hub-Signature-256` with prefix `sha256=`. |
| `timestamped` | `t=<unix>,v1=<hex HMAC-SHA256 of "t.body">` within five minutes (Stripe's scheme, and Postbox's own outbound webhooks).                 |

Comparisons are constant-time and use the raw request bytes. A request that fails verification gets `401`, is stored
with `signature: invalid` or `missing` so you can debug it, and is never forwarded.

## What is stored, and limits

- Method, path, query, headers and body of each request, the signature result and the response sent.
  `Authorization`, `Cookie`, `Proxy-Authorization`, `Set-Cookie`, `X-Api-Key` and a shared-token header are stored as
  `[redacted]`. At most 100 headers of 2,000 characters are kept.
- Bodies up to **256 KB**. A larger body (or a `Content-Length` above it) gets `413` before it is read, and is not
  stored. Non-UTF-8 bodies are kept losslessly as base64.
- The newest **200** requests per listener; older ones are removed as new ones arrive.
- Requests older than the **Settings → Data → Keep received webhook requests for** period (default 30 days; 0 keeps
  them until the 200 limit pushes them out).
- A per-listener rate limit (default 120 per minute, configurable up to 6,000). Excess requests get `429` and are not
  stored. Up to 20 listeners per workspace.

Request content is shown as plain text in the interface and is never echoed in a response.

## Response

Each listener answers with a configured status (200–599, not 3xx), content type and body (up to 4,096 characters),
by default `200 {"ok":true}`. Responses carry `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` and a
sandboxing Content-Security-Policy.

## Forwarding and replay

Set a **forward URL** and Postbox sends each verified request to it as it arrives, with the original method, body and
`Content-Type`, plus `Postbox-Listener` and `Postbox-Event-Id` headers. Credentials and signature headers are not
passed on. The result (status or error) is recorded on the request.

**Replay** re-sends one stored request to the forward URL, or to a URL you supply, and only when you ask: the Replay
button, or `POST /api/hook-listeners/{id}/replay` with `{"eventId": "…", "url": "…"}`. Nothing is replayed
automatically and a failed forward is not retried.

Forward and replay targets must be http(s) addresses allowed by this server's outbound host policy
(`PROXY_ALLOW_HOSTS` / `PROXY_DENY_HOSTS`), checked when you save and again, including the resolved IP, at send time.
Redirects are not followed.

## Secrets

Verification secrets are currently stored in the database next to the listener. Referencing secrets from a vault
needs the secrets vault (LAB-75) and is tracked as follow-up work.

## REST API

| Method and path                             | Purpose                                                    |
| ------------------------------------------- | ---------------------------------------------------------- |
| `GET /api/hook-listeners?workspaceId=`      | List listeners.                                            |
| `POST /api/hook-listeners`                  | Create. The response contains `token` and `path` once.     |
| `GET/PATCH/DELETE /api/hook-listeners/{id}` | Read, change (`status`, response, verification…), delete.  |
| `POST /api/hook-listeners/{id}/rotate`      | New URL.                                                   |
| `GET /api/hook-listeners/{id}/events`       | Recent requests (`?limit=`), or one with body (`?event=`). |
| `DELETE /api/hook-listeners/{id}/events`    | Clear stored requests.                                     |
| `POST /api/hook-listeners/{id}/replay`      | Re-send one stored request.                                |

Changes are recorded in the audit log without tokens, secrets or payloads.
