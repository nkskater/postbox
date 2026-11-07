# Collections as repository files

Keep a collection in Git (or any file-based workflow): Postbox can write it out as plain files, and read edited
files back. The files are **stable** (the same collection always produces identical bytes, so unrelated edits
never touch the same lines), **secret-free**, and made to diff and merge well. Git does the history, branches
and merging; Postbox is the bridge.

## Layout

```
collection.json                 the collection: name, description, auth shape, headers, order of its children
collection.pre-request.js       its scripts, only when it has any
collection.test.js
variables.json                  collection variables (secret values are blank)
list-pets--8fK2.request.json    one file per request
list-pets--8fK2.pre-request.js  its scripts, as real .js files
list-pets--8fK2.test.js
admin--Qx91/folder.json         a folder is a directory with folder.json (+ folder.pre-request.js / folder.test.js)
admin--Qx91/delete-pet--Pp40.request.json
```

- File names are `<slug>--<id>`: readable, and the id keeps them unique and stable. Renaming a request in the app
  renames its file (Git shows it as a rename); the JSON inside keeps the id.
- Every JSON file has `"format": 1`, sorted keys, two-space indent and a final newline.
- `order` in `collection.json` / `folder.json` lists the ids of the children in display order.
- Scripts are separate `.js` files so edits show as normal code diffs. A script file always ends with one extra
  newline that is removed when reading, so scripts round-trip exactly.
- **Nothing secret is written.** Auth secrets, secret variables, uploaded file bytes and the values of
  sensitive-looking headers, parameters and fields are blank. References like `{{baseUrl}}` and
  `{{vault:token}}` are kept. Credentials already stored in Postbox are never overwritten by a push.
- Other files in the directory (README, CI config, `.git`) are ignored.

## Environments

An environment is two files: `environment.json` (`format`, `id`, `name`) and `variables.json`. Secret variables
are written with an empty value, so nothing secret is in the files, and a push never overwrites a secret already
stored in Postbox. A directory holds one thing: a collection, an environment or a specification.

```sh
postbox env pull <environmentId> --dir ./staging
postbox env push --dir ./staging [--dry-run] [--prune] [--force]
postbox collection import-dir ./staging -w <workspace>      # a directory with environment.json creates an environment
```

`push` has the same guard as collections (refused if the environment changed since the pull). Without `--prune`,
variables missing from the file are left alone. `env push` refuses a collection directory and `collection push`
refuses an environment one.

## API specifications

A specification is `specification.json` (`format`, `id`, `name`, `specification` kind, `entrypoint`, `label`)
and its source files, untouched, under `source/` (so `source/openapi.yaml`, `source/schemas/pet.yaml`, ...). A
spec already has numbered revisions, so the **revision** is the checksum: a push is only accepted against the
revision it was pulled from and becomes the next revision (earlier revisions are kept). Pushing unchanged files
does nothing; the spec's kind cannot change; sources removed from `source/` are removed from the new revision.

```sh
postbox spec pull <specificationId> --dir ./petstore-spec
postbox spec push --dir ./petstore-spec [--dry-run] [--force]
postbox collection import-dir ./petstore-spec -w <workspace>    # specification.json creates a specification
```

REST: `GET/PUT /api/specifications/{id}/files`.

## In the app

Collections have a **Repository** tab; environments and specifications have a **Repository** section. It shows
the files Postbox would write right now (count, list, and a JSON download), the checksum a push is guarded by,
and the commands to pull, preview (`--dry-run`) and push, ready to copy with the directory and id filled in.
Previewing and pushing run from the command line because that is where your repository files are.

## Command line

```sh
postbox collection pull <collectionId> --dir ./api          # write the files (+ .postbox-repo.json)
git add -A && git commit                                    # versioning, branches, review: Git's job
postbox collection push --dir ./api [--dry-run] [--prune]   # apply edited files back
postbox collection import-dir ./api -w <workspace>          # create a new collection from files
```

`pull` records the collection and a checksum in `.postbox-repo.json`. Commit it with the files. A later `pull`
removes files the collection no longer has and leaves your own files alone.

`push` sends the repository files and the recorded checksum. If the collection in Postbox **changed since the
pull**, the push is refused (exit 5) and nothing is applied: pull again, resolve any differences with Git's
normal merge, and push. `--force` skips the check. Files for new requests and folders (no `id`) are created;
run `pull` afterwards so they get ids. Without `--prune`, anything missing from the files is left alone; with
it, missing requests, folders and variables are removed. `--dry-run` prints the diff and plan only.

Exit codes follow the other management commands (`push` refused: 5; usage mistakes: 2).

## REST API

| Route | Purpose |
|---|---|
| `GET /api/folders/{id}/files` | `{ format, checksum, files }` for the collection |
| `PUT /api/folders/{id}/files` | `{ files, baseChecksum, prune?, force?, dryRun? }` apply edited files |
| `GET /api/environments/{id}/files` · `PUT` | The same for an environment |
| `GET /api/specifications/{id}/files` · `PUT` | The same for a specification (revision as checksum) |
| `POST /api/import/files` | `{ workspaceId, files }` create a new collection, or an environment if the files have `environment.json` |

Reading needs the *viewer* role; push and import need *editor*. Malformed files are rejected with the offending
path (400); unsafe paths (`..`, absolute, backslashes) and oversized input (5000 files, 2 MB per file) are
refused.

## Not covered yet

This is the file format and the pull/push/import path. Not yet part of it: Postbox running `git` itself
(connecting a repository, status, commit, branch, push and pull against a remote, with repository hooks
disabled).
