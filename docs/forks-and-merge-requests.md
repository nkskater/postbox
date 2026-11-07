# Forks and merge requests

Work on a change to a collection without touching the original, keep your copy up to date with it, and propose
the change back for review.

## Forking

Open a collection → **Forks** → pick a workspace → **Fork**. You get your own copy that remembers which
collection it came from and what that collection looked like at that moment. Forking needs read access to the
original and write access to the workspace you fork into.

Credentials are never copied. Auth secrets, secret variables and the values of sensitive-looking headers and
fields start blank in a fork; references such as `{{vault:token}}` are kept.

A fork shows how it relates to its original:

| Shown | Meaning |
|---|---|
| Same as the original | Nothing differs from when you last agreed |
| Has changes the original does not | You have edits to propose |
| The original has changes you do not | Pull them in with **Update from original** |
| Changed on both sides | Both of the above |
| The original is not available | It was deleted, or you can no longer read it |

## Keeping a fork up to date

**Update from original** previews what the original changed since you last agreed, then applies it with a
three-way merge: changes to things you did not touch come in, your own edits stay, and things you added are
never touched. If the same item changed on both sides it is a **conflict**; the update stops (default) or you
choose **Keep my version** / **Use the original's**. Your own credentials survive an update. A fork and its
original may have different names; a rename is never carried across.

## Proposing changes

On a fork that has changes, enter a title and **Open merge request**. A fork has at most one open request. The
request shows the structural diff: requests and folders added, removed and changed (with which fields),
and variable changes. Everyone who can read the original can read it and join the discussion in the comments
under it.

### Review

People with the *editor* role or above in the **original's** workspace can review:

- **Approve** or **Request changes**, with an optional note.
- You cannot approve your own request.
- A review applies to the exact content it was given on. If the fork changes afterwards, earlier approvals and
  requests for changes go **out of date** and the request needs a fresh look, so nothing is merged that nobody
  saw.

### Merging

**Merge** applies the request to the original. It is allowed when:

1. there is something to merge;
2. it does not **conflict** with edits made to the original since the fork (it never overwrites them; update
   the fork first to resolve);
3. no standing review asks for changes;
4. it is approved by someone other than its author, **unless** the person merging is an owner of the original's
   workspace;
5. if it changes **scripts or saved examples** (pre-request, post-response, response examples; including on new
   requests), the person merging is an **owner**.

Credentials in the original are kept when a merge updates the same request. After a merge the fork and the
original agree again, so a follow-up change updates the same items instead of adding duplicates.

The author or an owner can **Close** a request without merging.

## Other places

Deleting the fork's collection, or **Stop tracking**, removes the fork and its merge requests with their
discussion. Deleting the original leaves forks working, marked "original not available".

## REST API

| Route | Purpose |
|---|---|
| `POST /api/folders/{id}/forks` | Fork a collection `{ workspaceId, name? }` |
| `GET /api/folders/{id}/forks` | Forks of a collection you can see |
| `GET /api/forks?workspaceId=` | Forks in a workspace, with ahead/behind counts |
| `GET /api/forks/{id}` · `DELETE /api/forks/{id}?deleteCopy=1` | Show / stop tracking |
| `GET /api/forks/{id}/sync` · `POST` `{ strategy }` | Preview / pull the original's changes |
| `POST /api/forks/{id}/merge-requests` | Open `{ title, description? }` |
| `GET /api/merge-requests?workspaceId=&status=` | Requests to review, or proposed from, a workspace |
| `GET /api/merge-requests/{id}` | Diff, conflicts, protected changes, reviews, readiness |
| `POST /api/merge-requests/{id}/reviews` | `{ decision: approve \| reject, note? }` |
| `POST /api/merge-requests/{id}/merge` | Merge |
| `POST /api/merge-requests/{id}/close` | `{ note? }` |
| `GET/POST /api/merge-requests/{id}/comments` | Review discussion |

`strategy` is `abort` (default), `keep-local` or `take-incoming`.

## Command line

```sh
postbox fork create <collectionId> -w <workspace> [--name "My fork"]
postbox fork list -w <workspace>
postbox fork status <id> [--fail-on behind,diverged]
postbox fork sync <id> [--preview [--fail-on-conflict]] [--strategy abort|keep-local|take-incoming]
postbox fork propose <id> --title "Add paging" [--description "..."]
postbox fork remove <id> [--delete-copy]

postbox mr list -w <workspace> [--status open|merged|closed]
postbox mr show <id> [--fail-unless-mergeable]
postbox mr approve <id> [--note "..."]
postbox mr request-changes <id> [--note "..."]
postbox mr merge <id>
postbox mr close <id> [--note "..."]
```

For CI: `fork status --fail-on`, `fork sync --preview --fail-on-conflict` and `mr show --fail-unless-mergeable`
exit 1 when the state matches (the last also prints why). `fork sync` with the default `abort` strategy and
`mr merge` that is refused (not approved, conflicts, owner-only) exit 5 and apply nothing. Deleting a fork's
collection asks for confirmation (`--yes` to skip).

## Not covered yet

Forking API specifications and merging into a specific past version are not part of this first version.
