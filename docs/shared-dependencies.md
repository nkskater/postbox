# Shared collection dependencies

Publish a collection as a numbered version, and install it into other workspaces. An installed copy stays
linked to the version it came from, so you can see when the source has moved on and update without losing
your own edits or credentials.

## Publishing

Open a collection → **Sharing** → enter a version (`1.0.0`, `2024.3`, `beta-2`) → **Publish**.

- A version is a frozen snapshot of the collection (folders, requests, scripts, collection variables). It
  can never be changed. To change it, publish the next version.
- **Credentials are never included.** Auth secrets, secret-typed variables, uploaded file bytes and the
  values of sensitive-looking headers, parameters, form fields and JSON body members are blanked.
  References such as `{{baseUrl}}` and `{{vault:token}}` are kept, since they are not secrets.
- Each snapshot has a SHA-256 checksum, shown next to the version.
- Publishing is refused if nothing changed since the newest version, or if the version already exists.
- Who can install it: **members of the workspace** (needs the *editor* role to publish) or **everyone on
  the server** (needs the *owner* role).

## Installing

**Import → Shared** lists releases that were shared with you from other workspaces. **Install** creates a new
collection in the current workspace and records which version and checksum it came from. A workspace cannot
install its own collections.

## Updating

Open the installed collection → **Sharing**. It shows the installed version and whether a newer one exists.
**Check for changes** lists what the new version adds, removes and changes, and where that collides with
edits you made.

The update is a three-way merge of the version you installed, the new version, and your copy as it is now:

| Upstream | You | Result |
|---|---|---|
| unchanged | unchanged | nothing |
| changed | unchanged | takes the new version |
| unchanged | changed | keeps your edit |
| changed | changed differently | **conflict** |
| removed | unchanged | removed |
| removed | changed (or you added items inside it) | **conflict** |

Things you added yourself are never touched. Your own credentials survive: where the new version has a blank
for a secret you filled in, your value is kept.

A conflict stops the update (default). You can instead **keep my version** or **use the new version** for
every conflict. Nothing is applied if the update stops.

## Withdrawing and availability

An owner of the source workspace can **withdraw** a version with a reason (for example a bad release). It can
no longer be installed or updated to; collections installed from it are flagged. Withdrawn versions stay
readable by existing installs.

If the source is deleted, or you lose access to it, the dependency shows **Source unavailable**. Your copy
keeps working and stays editable; only updates are unavailable. **Stop tracking** removes the link and keeps
the collection (or deletes it, with `?deleteCopy=1`).

## REST API

All routes need an API key or session with access to the workspace involved.

| Route | Purpose |
|---|---|
| `GET /api/folders/{id}/releases` | Versions of a collection |
| `POST /api/folders/{id}/releases` | Publish `{ version, notes?, visibility? }` |
| `GET /api/dependency-releases?workspaceId=` | Releases you may install into that workspace |
| `GET /api/dependency-releases/{id}` | One release |
| `POST /api/dependency-releases/{id}/revoke` | Withdraw `{ reason }` |
| `GET /api/dependencies?workspaceId=` | Installed dependencies with status |
| `POST /api/dependencies` | Install `{ workspaceId, releaseId }` |
| `GET /api/dependencies/{id}/preview?releaseId=` | Diff and merge plan |
| `POST /api/dependencies/{id}/update` | `{ releaseId?, strategy: abort \| keep-local \| take-incoming }` |
| `DELETE /api/dependencies/{id}?deleteCopy=1` | Stop tracking |

Status is one of `current`, `update-available`, `withdrawn`, `source-unavailable`.

## Command line

```sh
postbox dependency publish <collectionId> 1.2.0 --notes "Adds paging" [--everyone]
postbox dependency releases <collectionId>
postbox dependency browse -w <workspace>             # releases you could install
postbox dependency install <releaseId> -w <workspace>
postbox dependency list -w <workspace>               # installed, with status and latest version
postbox dependency status <id> --fail-on update-available,withdrawn
postbox dependency preview <id> [--release <releaseId>] [--fail-on-conflict]
postbox dependency update <id> [--release <releaseId>] [--strategy abort|keep-local|take-incoming]
postbox dependency withdraw <releaseId> --reason "Broke auth"
postbox dependency remove <id> [--delete-copy]
```

For CI: `status --fail-on` and `preview --fail-on-conflict` exit 1 when the state matches. `update` with the
default `abort` strategy exits 5 (rejected) when your edits collide with the new version, and applies nothing.
Deleting the copy asks for confirmation (`--yes` to skip).

## Not covered yet

Environments and mock servers as dependency kinds, and review before publishing (waiting on the review
workflow), are not part of this first version.
