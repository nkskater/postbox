# CLI: workspace and asset management

Besides `postbox run`, the CLI can manage a running Postbox server over its REST API. Nothing here reads the
database directly or contacts any third-party service; the only network peer is the server you configure.

## Connecting

```bash
postbox profile add dev https://postbox.example.com --token-env POSTBOX_DEV_TOKEN --default
postbox profile add local http://localhost:3000 --token-stdin < token.txt
postbox profile list
postbox profile use dev
```

Profiles live in `~/.config/postbox/profiles.json` (`$XDG_CONFIG_HOME`, or `POSTBOX_CONFIG` for another path). The
file is written atomically with mode `0600`. With `--token-env`, the profile stores only the variable name and the
token is read from the environment each time, so nothing secret reaches disk. `profile list` never prints a full
token.

Connection settings are resolved in this order: `--url` / `--token` / `--profile`, then `POSTBOX_URL`,
`POSTBOX_TOKEN` and `POSTBOX_PROFILE`, then the current profile. Prefer the environment or a profile over `--token`,
because command-line arguments are visible to other users on the machine. Use a personal API token or a service
account key (see [service accounts and keys](service-accounts-and-keys.md)); its role and scope apply, and every
change is audited.

## Commands

| Group           | Commands                                                                                                                   |
| --------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `workspace`     | `list`, `get`, `create <name>`, `rename <id> <name>`, `delete <id>`                                                        |
| `collection`    | `list`, `get`, `create <name>`, `rename`, `duplicate`, `delete`, `export <id>`                                             |
| `folder`        | `list`, `create <name> --parent <id>`, `rename`, `duplicate`, `delete`                                                     |
| `request`       | `list [--folder]`, `get`, `create --folder <id> [-f file]`, `update -f file`, `duplicate`, `delete`                        |
| `example`       | `list <requestId>`, `apply <requestId> -f mutation.json`                                                                   |
| `env`           | `list`, `get`, `create <name> [-f vars.json]`, `update <id> [--name] [-f vars.json]`, `duplicate`, `delete`, `export <id>` |
| `globals`       | `get`, `set -f vars.json`, `export`                                                                                        |
| `mock`          | `list`, `get`, `logs <id>`, `reset <id>`, `delete <id>`                                                                    |
| `import <file>` | Import a Postman collection, HAR, OpenAPI or other supported file (`--preview`, `--include-credentials`)                   |

Commands that need a workspace take `-w, --workspace <id>` or `POSTBOX_WORKSPACE`. When the account has exactly one
workspace it is used automatically. JSON input flags accept a file path or `-` for standard input. Exports go to
standard output, or to a file with `--out`; secrets are left out unless `--include-secrets` is given.

Request definitions and variable lists use the same JSON as the REST API, for example
`[{"key":"host","value":"example.com","type":"default","enabled":true}]`.

## Output and paging

`-o json` prints machine-readable JSON, `-o table` a table. The default is a table in a terminal and JSON when
output is piped, so scripts get stable output without a flag. List commands print
`{"items": [...], "total": n, "offset": n, "limit": n|null}` and accept `--limit` and `--offset`.

## Confirmations

Deleting anything asks first when run in a terminal. Without a terminal the command refuses (exit 2) unless
`--yes` / `-y` is passed, so a script can never delete by accident.

## Exit codes

| Code | Meaning                                                    |
| ---- | ---------------------------------------------------------- |
| 0    | Success                                                    |
| 1    | Failed (for `run`: a failed request or assertion)          |
| 2    | Usage error, missing configuration, or confirmation needed |
| 3    | Authentication failed or not permitted (401, 403)          |
| 4    | Not found (404)                                            |
| 5    | Rejected by the server (other 4xx)                         |
| 6    | Rate or quota limited (429)                                |
| 7    | Server error (5xx)                                         |
| 8    | Server unreachable or timed out                            |

`run` keeps its own codes (130 and 143 for interrupts).
