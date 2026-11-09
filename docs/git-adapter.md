# Git adapter

`postbox git` keeps a pulled collection directory (see [repository-format.md](repository-format.md)) in a Git
repository: connect it to a remote, see what changed, commit, branch, push and pull. Merging stays Git's job;
Postbox makes the round trip safe and hands conflicted files back to you.

```sh
postbox collection pull <id> --dir ./pets
postbox git connect -d ./pets --remote https://github.com/acme/pets-api.git
postbox git status  -d ./pets
postbox git commit  -d ./pets -m "Document the pets API"
postbox git push    -d ./pets --token-env GITHUB_TOKEN

postbox git pull    -d ./pets --token-env GITHUB_TOKEN
postbox collection push --dir ./pets          # apply what you pulled to Postbox
```

| Command                                                       | What it does                                                                                                                  |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `connect --remote <url> [--branch main]`                      | Makes the directory a repository (if it is not one) and sets `origin`. Safe to repeat.                                        |
| `status [--json]`                                             | Branch, upstream, ahead/behind, and each changed file (`added`, `modified`, `deleted`, `renamed`, `untracked`, `conflicted`). |
| `diff`                                                        | The uncommitted changes.                                                                                                      |
| `commit -m <text>`                                            | Stages everything and commits. Does nothing when the tree is clean.                                                           |
| `branch list`, `branch create <name>`, `branch switch <name>` | Branches.                                                                                                                     |
| `push`                                                        | Pushes the current branch (setting its upstream the first time). Never forces.                                                |
| `pull`                                                        | Fetches `origin` and merges the current branch. Refuses over uncommitted changes.                                             |
| `continue` / `abort`                                          | Finish a conflicted merge once the files are edited, or abandon it.                                                           |

`--name` and `--email` set the commit author (default `Postbox <postbox@localhost>`); git's own global
configuration is never read, so your identity has to come from these.

## Conflicts

When a pull cannot merge cleanly the merge is left in progress, `pull` exits **5** and lists the conflicted
files, which contain ordinary conflict markers. Edit them (they are small, sorted JSON and `.js` files, so the
conflicts are usually a line or two), then `postbox git continue`. `continue` refuses while markers remain.
`postbox git abort` puts the directory back exactly as it was before the pull.

After a pull that changed files, run `collection push` to apply them to Postbox.

## Credentials

Secrets never go into the repository files or the remote URL (a URL with a user, password or token in it is
refused, because git would store it in `.git/config`). For https remotes pass the name of an environment
variable holding the token with `--token-env`; it is handed to git through a throw-away askpass helper and is
removed from any output. The Postbox vault is write-only over the API, so tokens for the CLI come from your
shell or CI secret store. For ssh remotes git uses your ssh agent and `known_hosts` (`BatchMode`, strict host
key checking, never a prompt).

## What git is not allowed to do

- **No hooks.** `core.hooksPath` points at an empty directory, and `--no-verify` is always passed.
- **No external programs.** No external diff, merge tool, textconv, filter or credential helper, no fsmonitor,
  no GPG, no aliases. A repository whose `.git/config` sets any of these (or `include`, `url.*.insteadOf`,
  proxies, ...) is refused with the setting named, so a repository you cloned cannot run code on your machine.
- **No shell, fixed environment.** Git is started directly with a fixed set of sub-commands and options Postbox
  builds itself. User input is only ever a validated branch name, a commit message passed as one argument, or a
  validated remote. Only `PATH`, `HOME`-style variables and the token you named reach it.
- **Only https and ssh remotes.** `http://`, `git://`, `ext::` and (unless `--allow-local`) local paths are
  refused. Branch names cannot start with a dash, contain `..`, or end in `.lock`.
- **Outbound policy.** The remote's host is checked against `PROXY_ALLOW_HOSTS` / `PROXY_DENY_HOSTS` before
  connecting and again before every push or pull, so a remote edited behind Postbox's back is still checked.

The per-machine `.postbox-repo.json` (what was pulled here) is excluded through `.git/info/exclude` and is never
committed; after cloning on another machine run `collection pull` once, or use `--force` on `collection push`.
