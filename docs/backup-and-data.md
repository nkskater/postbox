# History, backups and database maintenance

Open **Settings → History & data** (administrators only; in a single-user install the owner is the administrator).

## History retention

| Setting                                    | Default | Meaning                                                                                                                                             |
| ------------------------------------------ | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| History entries per workspace              | 500     | Older entries are removed once a workspace has more. The `HISTORY_LIMIT` environment variable overrides this.                                       |
| Keep history for                           | 0 days  | Entries older than this are removed (0 keeps them until the entry limit is reached). Applied when a request is recorded and when history is listed. |
| Skip history for requests that use secrets | off     | A request whose sent URL, headers or body used a secret variable or credential is not recorded.                                                     |

## Backup

**Download backup** (`GET /api/backup`) saves one JSON file with every workspace, collection,
request, environment, variable, dataset (with versions), schedule, workspace membership and
instance setting. It does not include accounts, sessions, API tokens, run results, history or cookies.

Secret values and request credentials are stored in the database in plain text, so a full backup
contains them in plain text too: keep the file like a credentials file. Clear **Include secret
values and credentials** (`GET /api/backup?secrets=omit`) for a scrubbed copy. It blanks secret
variables, authorization credentials on folders and requests, secret dataset columns (the dataset
is marked as missing its secrets) and credential-looking header values (`Authorization`, tokens,
API keys, cookies). This is best effort: query parameters, request bodies and scripts are kept
as they are, so review the file before sharing it.

## Restore

**Restore from file…** (`POST /api/backup` with `{ "backup": …, "confirm": "restore" }`) replaces
**all** workspace data with the file, atomically: if anything in the file is invalid, nothing changes.

- Every current workspace is deleted first, together with its history, cookies, run results and
  invites. Download a backup before restoring if you may need the current data.
- Accounts and API tokens are kept. A workspace membership, dataset creator or schedule owner that
  refers to an account that does not exist here is dropped (the workspace itself is restored, and
  administrators can always open it).
- Instance settings in the file are validated; unknown or invalid ones are skipped and reported.
- A backup restores into any Postbox database, including a fresh one, because it contains no
  instance-specific keys.

## Database maintenance

- **Database** shows the file path, size, write-ahead log size, space that can be reclaimed, and
  record counts (`GET /api/backup/info`).
- **Compact database** (`POST /api/backup/compact`) checkpoints and vacuums the database so the
  file shrinks after large deletions.
- **Clear data** (`POST /api/backup/clear` with `{ "target": "history" | "cookies" | "runs", "workspaceId"? }`)
  deletes history, cookies or run results for the current workspace or all of them.

All of these routes require an administrator.
