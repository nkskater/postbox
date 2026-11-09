# CLI projects, command metadata and agent skills

The CLI can set up a folder of API tests, check that it is healthy, describe its own commands as JSON and install
task-specific skills for coding agents. All of it works offline and never changes files you did not ask it to.

## `postbox init`

```sh
postbox init [dir] [--name "Orders API"] [--base-url http://localhost:8080] [--dry-run] [--json]
```

Creates a project in `dir` (default: the current directory):

```
postbox.json                                  project config
collections/<name>.postman_collection.json    a sample collection with one request and a test
environments/local.postman_environment.json   baseUrl for local runs
.gitignore                                    ignores reports/ and postbox-report.*
```

Only files that do not exist yet are written. Each file is reported as `created` or `kept`, and an existing file is
never overwritten, so it is safe to run in a repository that already has sources (an existing `.gitignore` is left
as it is; `doctor` tells you if `reports/` is not ignored). When `postbox.json` already exists, `init` only recreates
missing files that the config lists. The same options always produce the same bytes.

### `postbox.json`

```json
{
  "format": 1,
  "name": "Orders API",
  "collections": ["collections/orders-api.postman_collection.json"],
  "environment": "environments/local.postman_environment.json",
  "data": "data/users.csv",
  "reports": "reports",
  "skills": ".agents/skills"
}
```

`collections` (1 to 50) is required; `environment`, `data` and `skills` are optional; `reports` defaults to
`reports`. Every path must be relative and stay inside the project.

## `postbox doctor` (alias `postbox status`)

```sh
postbox doctor [dir] [--json]
```

Runs these checks in a fixed order:

| Check | Fails when |
| --- | --- |
| `node` | Node.js is older than 22 |
| `config` | `postbox.json` is missing or invalid (the remaining checks are skipped) |
| `collection:<path>` | a collection is missing, is not a Postman collection or HAR file, or has no requests |
| `environment` | the environment is missing or not a Postman environment |
| `data` | the data file is missing |
| `reports` | warns when the reports directory is not in `.gitignore` |
| `git` | warns when the project is not in a Git repository |
| `skill:<name>` | a skill in the `skills` directory is missing files; warns when it is outdated or edited |

Each check is `ok`, `warn` or `fail`. The exit code is `0` unless a check fails, then `5`. Messages do not depend on
timing, so the output is the same for the same files and can be compared in CI.

## `postbox describe`

```sh
postbox describe                    # every command
postbox describe collection pull    # one command (names or aliases)
```

Prints JSON for scripts and agents: `format` (currently `1`), `cli`, `version`, `exitCodes` and a `command` tree.
Each command has `name`, `path`, `description`, `aliases`, `arguments` (`name`, `required`, `variadic`, `default`),
`options` (`flags`, `long`, `short`, `value` of `required`/`optional`/`none`, `mandatory`, `negate`, `default`,
`choices`) and its subcommands. An unknown command exits `4`.

## `postbox skills`

Postbox ships skills (a `SKILL.md` with name, description and version front matter) that teach coding agents how to
use it:

| Skill | Covers |
| --- | --- |
| `postbox-project` | `init`, `doctor`, `describe` |
| `postbox-collection-runs` | `postbox run` options, reporters, exit codes and CI use |
| `postbox-repository-files` | pulling, editing and pushing collection files, and resolving conflicts |
| `postbox-server-management` | profiles, management commands, JSON output and exit codes |

```sh
postbox skills list [--dir <path>] [--json]
postbox skills install --dir .agents/skills postbox-project postbox-collection-runs
postbox skills install --dir .agents/skills --all
postbox skills update --dir .agents/skills [names...] [--dry-run] [--force]
```

Skills are installed only by name (or `--all`) and only into the `--dir` you give. Postbox never edits agent
configuration files or picks a directory for you. Point `--dir` at wherever your agent loads skills from.

`--dir` gets one folder per skill and a `.postbox-skills.json` manifest with each skill's version and the SHA-256 of
every file it wrote. On `install` or `update`:

- a missing file is created;
- a file that still matches what Postbox wrote is replaced with the new version;
- a file you edited, or one Postbox did not write, is **kept** and reported (`kept-edited`, `kept-untracked`);
  `--force` replaces it;
- a file a newer version no longer ships is removed if unedited, otherwise kept.

`skills list --dir` shows each skill as `not-installed`, `current`, `outdated`, `edited` or `missing-files`.
Usage mistakes (unknown skill, no `--dir`, updating a skill that is not installed) exit `2`.
