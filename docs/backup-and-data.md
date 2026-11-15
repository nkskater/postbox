# History, backups and database maintenance

Open **Settings → History & data** (administrators only; in a single-user install the owner is the administrator).

## History retention

| Setting                                    | Default | Meaning                                                                                                                                             |
| ------------------------------------------ | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| History entries per workspace              | 500     | Older entries are removed once a workspace has more. The `HISTORY_LIMIT` environment variable overrides this.                                       |
| Keep history for                           | 0 days  | Entries older than this are removed (0 keeps them until the entry limit is reached). Applied when a request is recorded and when history is listed. |
| Skip history for requests that use secrets | off     | A request whose sent URL, headers or body used a secret variable or credential is not recorded.                                                     |

## Backup

**Download backup** (`GET /api/backup`) saves one JSON file with the configuration of every
workspace, the instance settings, the outbound proxy and TLS profiles (see
[outbound-network.md](outbound-network.md)).

Included:

- workspaces and memberships, collections, folders, requests, environments and variables
- datasets (with versions), schedules, monitors, mock servers, gRPC definitions and script packages
- specifications (with versions and links), governance and scorecard rules and their assignments
- the API catalog, published documentation, telemetry sources and the vault
- brokered APIs and their gateway routes
- outbound webhooks, incoming hook listeners and saved MCP calls
- comments, collection forks, merge requests and their reviews
- collection and environment releases, installed dependencies and private runners

Not included (a restore deletes these with the workspaces they belong to):

- accounts, sessions, API tokens and the settings of individual accounts
- single sign-on providers and usage limits
- run results, load test results, request history and cookies
- mock server request logs, webhook delivery log, requests received by incoming hook listeners
- monitor results, monitor incidents, monitor e-mail log and queued and finished runner jobs
- received telemetry, captured traffic, gateway sessions and gateway traces
- governance reports (run the checks again) and scorecard reports (run the scorecards again)
- the dependency graph index (rebuilt with Refresh)
- comment notifications of individual accounts
- pending invitations (send them again)
- access granted to brokered APIs (approve it again)
- groups provisioned by the identity provider (provisioned again on its next sync)
- roles granted through single sign-on (granted again at the next sign-in)

Secret values and request credentials are stored in the database in plain text, so a full backup
contains them in plain text too: keep the file like a credentials file. Clear **Include secret
values and credentials** (`GET /api/backup?secrets=omit`) for a scrubbed copy. It blanks secret
variables, authorization credentials on folders and requests, secret dataset columns (the dataset
is marked as missing its secrets) and credential-looking header values (`Authorization`, tokens,
API keys, cookies). Webhook signing keys and header values, listener and runner tokens and
saved MCP call headers are left out as well. This is best effort: query parameters, request bodies and scripts are kept
as they are, so review the file before sharing it.

## Restore

**Restore from file…** (`POST /api/backup` with `{ "backup": …, "confirm": "restore" }`) replaces
**all** workspace data with the file, atomically: if anything in the file is invalid, nothing changes.

- Every current workspace is deleted first, together with everything listed under "Not included"
  above. Download a backup before restoring if you may need the current data.
- Usage counters of gateway routes start again from zero, and runners show as not yet seen.
- From a backup without secrets, webhooks come back switched off with a new signing key (use
  **Rotate secret** to see it), incoming hook listeners come back paused and need a new URL
  (**New URL**, then **Resume**), and runners come back revoked, so register them again.
- Accounts and API tokens are kept. A workspace membership, dataset creator or schedule owner that
  refers to an account that does not exist here is dropped (the workspace itself is restored, and
  administrators can always open it).
- Instance settings in the file are validated; unknown or invalid ones are skipped and reported.
- A backup restores into any Postbox database, including a fresh one, because it contains no
  instance-specific keys.

## Database snapshots

The JSON backup is for moving configuration between instances; it leaves out accounts, API keys,
history and runs. A **snapshot** is a complete copy of the SQLite database instead, taken with
`VACUUM INTO` while Postbox keeps running:

- `GET /api/backup/snapshot` (administrators only) downloads it as `postbox-snapshot-<time>.db`.
- From a terminal: `postbox backup snapshot --out postbox-snapshot.db` (written readable by you only).

A snapshot contains every credential and secret Postbox stores, in plain text. Keep it like the
database file itself.

### Before upgrades

When a new version starts and finds database migrations it has not applied yet, it first saves a
snapshot of the database as it was, next to the database file:

```
postbox.db.pre-migration-20261114T120000Z-0046_fluffy_winter_soldier.db
```

The name holds the time and the last migration the old version had applied. The server log has one
line saying where it went. The newest three are kept. Settings:

| Variable                           | Default               | Meaning                                                               |
| ---------------------------------- | --------------------- | --------------------------------------------------------------------- |
| `POSTBOX_SNAPSHOT_DIR`             | the database's folder | Where pre-migration snapshots are written                             |
| `POSTBOX_SNAPSHOT_KEEP`            | `3`                   | How many pre-migration snapshots to keep                              |
| `POSTBOX_SKIP_MIGRATION_SNAPSHOT`  | _(unset)_             | `1` skips the snapshot, for very large databases you back up yourself |
| `POSTBOX_MIGRATE_WITHOUT_SNAPSHOT` | _(unset)_             | `1` lets the upgrade continue when the snapshot cannot be written     |

If the snapshot cannot be written (disk full, read-only folder), Postbox does not start and says
why, rather than migrate without a way back. Free space, point `POSTBOX_SNAPSHOT_DIR` elsewhere, or
set `POSTBOX_MIGRATE_WITHOUT_SNAPSHOT=1`.

### Rolling back an upgrade

1. Stop Postbox (`docker compose down`, or close the app).
2. Move `postbox.db`, `postbox.db-wal` and `postbox.db-shm` out of the way.
3. Copy the snapshot to `postbox.db` (no `-wal`/`-shm` files are needed).
4. Start the previous version (for Docker, the previous image tag).

To restore a downloaded snapshot, follow the same steps with that file.

## Database maintenance

- **Database** shows the file path, size, write-ahead log size, space that can be reclaimed, and
  record counts (`GET /api/backup/info`).
- **Compact database** (`POST /api/backup/compact`) checkpoints and vacuums the database so the
  file shrinks after large deletions.
- **Clear data** (`POST /api/backup/clear` with `{ "target": "history" | "cookies" | "runs", "workspaceId"? }`)
  deletes history, cookies or run results for the current workspace or all of them.

All of these routes require an administrator.

Workflow backups include drafts, encrypted versions and deployment settings. Keep the external vault keyring separately. Restored deployments are disabled and have no webhook token; save to adopt a current owner before enabling them. Exports without secrets omit versions and deployments and retain scrubbed drafts. Excluded: workflow run results and webhook deduplication records.
