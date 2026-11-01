# Service accounts and API keys

Keys let the CLI, CI jobs, scripts and MCP clients call Postbox. Every key belongs to an account and can be limited
in three ways: a **scope**, an optional **rate limit** and an **expiry**.

## Scopes

| Scope   | Allows                                                                                   |
| ------- | ---------------------------------------------------------------------------------------- |
| `read`  | Look at workspaces, requests, history and runs.                                          |
| `run`   | Read, plus send requests, run collections and use live connections.                      |
| `write` | Run, plus create and change workspace content and save settings.                         |
| `full`  | Everything the owner may do, including managing members, keys, invites and the instance. |

A key never does more than its owner. The scope narrows the owner's role, so a `full` key held by a workspace editor
still cannot delete the workspace or manage members. Keys created before scopes existed are `full`.

## Personal keys

Profile → API keys. Choose a name, scope, expiry and an optional limit in requests per minute. The key is shown once.
Use the rotate button to replace a key: the new key has the same scope, limit and lifetime, and the old key keeps
working for 15 minutes so clients can switch.

## Service accounts

Administrators create service accounts under Settings → Users → Service accounts, for automation that should not
depend on one person. A service account:

- has no password and cannot sign in; it is reached only through keys,
- has no private workspace; add it to workspaces like any member (Members, as viewer, editor or owner),
- can hold several keys with different scopes, limits and expiry,
- stops working entirely when disabled, and its keys can be revoked or rotated at any time by an administrator.

```bash
curl -H "Authorization: Bearer pbx_…" http://localhost:3000/api/workspaces
```

## Rate limits

A key with a limit gets `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset` (seconds) on every
response. Beyond the limit, requests get `429` with a `Retry-After` header until the one-minute window resets.
Counters live in memory, so they reset when the server restarts, and each server process counts on its own.

## API

| Route                                         | Purpose                                                              |
| --------------------------------------------- | -------------------------------------------------------------------- |
| `GET/POST /api/admin/service-accounts`        | List service accounts with their keys; create one. Administrators.   |
| `POST /api/admin/service-accounts/:id/tokens` | Issue a key `{ name, scope?, expiresInDays?, rateLimitPerMinute? }`. |
| `DELETE /api/admin/tokens/:id`                | Revoke any key. Administrators.                                      |
| `POST /api/admin/tokens/:id/rotate`           | Rotate a key `{ graceMinutes? }`. Administrators.                    |
| `POST /api/me/tokens`                         | Create a personal key (same fields).                                 |
| `POST /api/me/tokens/:id/rotate`              | Rotate one of your own keys.                                         |
