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
| `POST /api/import/files` | `{ workspaceId, files }` create a new collection |

Reading needs the *viewer* role; push and import need *editor*. Malformed files are rejected with the offending
path (400); unsafe paths (`..`, absolute, backslashes) and oversized input (5000 files, 2 MB per file) are
refused.

## Not covered yet

This is the file format and the pull/push/import path. Not yet part of it: Postbox running `git` itself
(connecting a repository, status, commit, branch, push and pull against a remote, with repository hooks
disabled), a workspace UI for it, API specifications, and environments.
