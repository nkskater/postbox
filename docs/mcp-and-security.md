# MCP controls and security settings

Open **Settings → MCP & integrations** or **Settings → Security & about** (administrators only).

## MCP endpoint

| Setting                 | Default  | Environment pin       | Effect                                                                                                                                      |
| ----------------------- | -------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Enable the MCP endpoint | on       | `MCP_ENABLED`         | When off, `POST /api/mcp` answers HTTP 503 and no tool runs.                                                                                |
| Read-only MCP           | off      | `MCP_READ_ONLY`       | Tools that create, change or delete data are hidden from `tools/list` and refused if called anyway.                                         |
| Extra allowed origins   | _(none)_ | `MCP_ALLOWED_ORIGINS` | Comma-separated browser origins that may call `/api/mcp`. Postbox's own origin and clients that send no `Origin` header are always allowed. |

When an environment variable is set it pins the setting and the control is locked.

**What read-only allows.** Every tool is classified by the access it needs. Read-only keeps the
tools that read or list data, identify the caller, send a request or run a collection; it removes
the rest (create, update, delete, move, duplicate, import, set variables, clear history and
cookies, manage examples, create or delete workspaces). Sending a request or running a collection
still records history and run results, because testing an API is the main use of MCP. A new tool
without a classification is treated as changing data.

**Connect a client.** The panel shows commands with your server's address filled in. They use
`YOUR_TOKEN`: create a personal API token on your profile page and substitute it. If sign-in is
off the commands carry no token.

## Sign-in and sessions

- **New sessions last** sets how long a new sign-in stays valid (1–365 days, `POSTBOX_SESSION_DAYS` pins it).
  Existing sessions keep the length they were created with.
- **Sign out all sessions** (`POST /api/admin/sessions/revoke`) ends every browser session, yours
  included: each account's session version is bumped and the single-user password session key is
  rotated. Personal API tokens and `POSTBOX_TOKEN` are not affected; revoke tokens separately.
- **About** shows the version and, for Docker images built with
  `--build-arg POSTBOX_COMMIT=$(git rev-parse --short HEAD)`, the build commit. `GET /api/admin/security`
  reports sign-in mode, whether `POSTBOX_PASSWORD` / `POSTBOX_TOKEN` are configured (never their values),
  the session length and version.
