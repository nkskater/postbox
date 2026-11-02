# Credential broker

The [secrets vault](secrets-vault.md) keeps a credential out of requests. The broker goes one step further: the people,
service accounts and agents that _use_ an API never hold its credential at all. They ask for access, a workspace owner
approves it with limits, and the consumer then calls the API **through Postbox**, which injects the credential and never
returns it.

Open **Settings → Variables & secrets → Credential broker**, or use the REST API or MCP.

## How it works

1. **Register an API** (workspace owner): a name, a base URL, the workspace vault secret that authenticates it and how
   that secret is attached (bearer token, a custom header, basic auth or a query parameter). Optionally limit the
   methods and path prefixes anyone may use.
2. **Request access** (any member who can run requests): `POST /api/broker/apis/:id/request`, with an optional reason.
   An owner can also grant access directly: `POST /api/broker/apis/:id/grant`.
3. **Approve** (workspace owner): `POST /api/broker/grants/:id/approve` with optional narrower `methods`, `pathPrefixes`
   and `expiresInSec` (at most 365 days). Or deny it.
4. **Call**: `POST /api/broker/grants/:id/call { method, path, headers?, body? }`. The grant id is the access
   reference. The path is relative to the API's base URL.
5. **Revoke** at any time (the consumer or an owner). Access stops immediately.

```
POST /api/broker/grants/brk_Tq3…/call
{ "method": "GET", "path": "/customers/42?expand=orders" }
```

The response carries `status`, `headers`, `contentType`, `body` (or `bodyBase64` for binary), `size`, `truncated` and
`redacted` (true when the API echoed the credential and Postbox masked it).

## What keeps the credential safe

- **Consumer-bound.** A reference only works for the identity it was approved for: the user (service accounts
  included), or `open` / `env` in the single-user modes. Anyone else, an owner included, gets the same "not found" as for
  a reference that does not exist, and the attempt is audited. A grant can also be bound to **one API key**
  (`bindToKey` when requesting, or `tokenId` when granting): the same person's other keys cannot use it.
- **Scoped destinations.** The consumer supplies only a path. It cannot choose the host, and the broker rejects
  absolute or protocol-relative paths, backslashes, control characters and dot segments (also percent-encoded).
  Redirects are not followed, so the credential cannot be steered elsewhere.
- **Scoped operations.** The API and each grant can limit the methods and path prefixes (matched on segment boundaries,
  so `/users` does not allow `/usersecrets`). A grant can only narrow what the API allows.
- **No credential in or out.** Headers that carry credentials (`Authorization`, `Cookie`, the injected header, …) cannot
  be supplied by the consumer. Every form of the credential (plain, URL-encoded, JSON-escaped, Base64) is masked in the
  response body and headers, and `Set-Cookie` is dropped.
- **Vault rules still apply.** The secret must be an enabled, workspace-wide vault secret (not personal, not limited to
  collections). If it has allowed domains, the API's host must match, and the same guard runs on every call. Disabling or
  deleting the secret, disabling the API or letting a grant expire ends access straight away. Calls follow the
  [outbound policy](outbound-network.md), including DNS checks, proxy and mTLS settings.
- **Audited.** Registrations, requests, approvals, denials, revocations and every call (method, path without query,
  status, duration; denied attempts too) are in the audit log. Credentials and query values are never recorded.

Backups include the registered APIs but not the access granted to consumers, so restoring never re-grants access
silently; approve it again.

Limits: 1 MiB request bodies, 5 MiB responses, 30 s per call, 100 APIs per workspace.

## REST

| Route                                   | Who                     |
| --------------------------------------- | ----------------------- |
| `GET/POST /api/broker/apis`             | read / owner            |
| `GET/PATCH/DELETE /api/broker/apis/:id` | read / owner            |
| `POST /api/broker/apis/:id/request`     | members who can run     |
| `POST /api/broker/apis/:id/grant`       | owner                   |
| `GET /api/broker/grants`                | owner: all; others: own |
| `POST /api/broker/grants/:id/approve`   | owner                   |
| `POST /api/broker/grants/:id/deny`      | owner                   |
| `POST /api/broker/grants/:id/revoke`    | the consumer or owner   |
| `POST /api/broker/grants/:id/call`      | the consumer            |

## MCP

`list_broker_apis`, `request_broker_access`, `list_broker_access` and `broker_call`. An agent can use an API without
the credential passing through its context; approval stays with a person.

## Not included

External secret managers (HashiCorp Vault, cloud providers) are not supported; credentials come from the Postbox vault.
There is no per-grant rate limit yet; API keys already have their own limits.
