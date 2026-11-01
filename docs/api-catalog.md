# API catalog

The **Catalog** rail opens a searchable catalog of permitted API/collection
entries. Search matches titles, summaries, tags and owner labels; the tag filter
matches an exact tag. Counts and pagination include only entries the caller can
read. Collection bodies/examples are not indexed. The consumer catalog is also
available at `/api/catalog?format=html`, including for anonymous public discovery.

Publish from a saved top-level collection's **Catalog publishing** tab. Save the
source collection and requests first, review the **Documentation** preview, then
provide a title, summary, comma-separated tags and owner labels, visibility, and
a version label such as `1.0.0`. Select **Publish catalog entry**. Only source
workspace owners with full management access can publish, change sharing, or
revoke. Owner labels describe responsibility; they do not grant permissions.

## Visibility and versions

| Visibility | Consumers                                                  |
| ---------- | ---------------------------------------------------------- |
| Private    | Source workspace owners and instance administrators.       |
| Team       | All source workspace members, including read-only viewers. |
| Public     | Anyone, including anonymous consumers.                     |

Authentication-off deployments and recovery/admin credentials retain their normal
owner privileges. Private/team membership is checked on every search, read,
download and import. Knowing an entry ID does not grant access. Consumers get
read-only snapshots; source editing and publishing are separate permissions.

Each publication captures sanitized saved collection data as a new immutable
integer version with a unique semantic-style label (`major.minor.patch`, optionally
followed by a prerelease suffix). **Publish new version** requires a new label and
the current sharing revision. Existing version labels and snapshots cannot be
overwritten. The latest version advances only on explicit publication; editing the
source collection does not change any published version.

**Update sharing & metadata** updates the title, summary, tags, owner labels and
visibility without replacing content versions. Sharing policy applies to every
retained version immediately. Both metadata updates and publishing increment the
sharing revision, and stale changes fail with 409. Reload status before retrying.
Displayed metadata is current even while browsing an older content snapshot.

In the catalog, choose **Published version** to inspect a specific version. Its
HTML page includes version navigation. Downloads and the import action stay pinned
to that displayed version, even if a newer version is published in the meantime.
Omitting a version through REST/MCP deliberately selects the latest at access time.

## Import, fork and revoke

**Import into Postbox** on an entry's documentation page loads authenticated
destination choices; select a workspace and explicitly choose **Import
collection**. The server checks destination write access and source visibility.
The result is an independent fork with new collection/request IDs. Source
credentials, variable values, scripts, settings and upload data are omitted;
configure them in the fork before use. The import response includes the source
entry ID, integer version and label. Fork edits do not change the catalog or source,
and later publication changes do not update a fork automatically.

The sanitized Postman collection download can be reviewed or imported into another
instance. Anonymous users can read public pages and download public collections,
but must sign in before importing into a workspace.

**Revoke catalog entry** deletes the entry and all retained versions, removing
search, read, download and import access. Publishing again creates a new ID; old
links remain invalid. Deleting the source collection/workspace also revokes it.
Previously downloaded data or already imported forks cannot be recalled.

Backups include catalog entries/versions. Restoring any backup leaves entries
disabled, including credential-inclusive backups. Review and republish to create
fresh IDs. Old public links remain invalid after restoration.

## Privacy and bounds

The catalog reuses the documentation whitelist and redaction rules. It retains
endpoint templates, sanitized bodies/examples, authentication type and variable
names/types, while omitting credential configuration values, all variable values,
scripts, upload bytes, contract metadata and original example requests. Known
workspace secrets and sensitive query/header/body values are redacted before
truncation, including encoded sensitive query names. Metadata uses the same known
secret redactions; tags containing a known secret are omitted. HTML is escaped,
uses nonce-based CSP, and loads no external content. Reads use `no-store`.

Mark credentials as secret variables and review the preview before public
publication. Redaction cannot recognize every arbitrary credential embedded in
unstructured text. Publishing and browsing never send endpoint requests or execute
source scripts/snippets.

Each snapshot has the documentation limits: 500 requests, folder depth 32 and
2 MiB of JSON, with bounded descriptions, parameter lists, bodies and examples.
A workspace can retain at most 64 catalog versions and 16 MiB of snapshots.
Snapshot bytes count toward retained workspace storage usage. Revoke obsolete
entries to free their versions. Metadata search uses indexed visibility/workspace
columns and authorization predicates before matching, counting or pagination.

## REST and MCP

| Method / path                                      | Behavior                                                                                      |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `GET /api/catalog`                                 | Authorized metadata discovery; anonymous results contain only public entries.                 |
| `GET /api/catalog?format=html`                     | Searchable consumer page.                                                                     |
| `GET /api/catalog/:id?version=N`                   | Metadata, selected sanitized snapshot and version history; defaults to latest.                |
| `GET /api/catalog/:id?format=html&version=N`       | Read-only documentation, version navigation, download and import controls.                    |
| `GET /api/catalog/:id?format=collection&version=N` | Sanitized pinned Postman collection download.                                                 |
| `POST /api/catalog/:id/import`                     | Authenticated `{workspaceId,version?}` creates an independent fork in a writable destination. |
| `GET /api/folders/:id/catalog`                     | Accessible entry metadata or `null`, plus `canPublish`.                                       |
| `PUT /api/folders/:id/catalog`                     | Owner explicitly publishes a new content version.                                             |
| `PATCH /api/folders/:id/catalog`                   | Owner updates full metadata/sharing without changing snapshots.                               |
| `DELETE /api/folders/:id/catalog`                  | Owner revokes every version.                                                                  |

Discovery accepts `query`, `tag`, optional `visibility`, `limit` (1–100, default 20)
and `offset` (default 0). It returns `{entries,total,limit,offset}`. LIKE wildcard
characters in query text are treated literally. No inaccessible entry is included
in the result count, page boundaries or matching metadata.

Publish body:

```json
{
  "title": "Pet API",
  "description": "Pet ownership operations",
  "tags": ["pets", "platform"],
  "owners": ["Platform team"],
  "visibility": "team",
  "label": "1.0.0",
  "expectedRevision": 0
}
```

Use revision 0 for a new/revoked/restored entry. PATCH accepts the same full
metadata and current `expectedRevision`, excluding `label`. Tags use lowercase
letters, digits and hyphens (up to 32 characters); maximum 20 tags and 10 owner
labels. Version selection uses a positive integer, not the semantic label.

MCP exposes `search_catalog` (`search` with discovery fields), `get_catalog_entry`
(`entryId`, `version?`), `get_collection_catalog` (`folderId`),
`publish_catalog_entry` (`folderId`, `publication` with the PUT body),
`update_catalog_entry` (`folderId`, `metadata` with the PATCH body),
`revoke_catalog_entry` (`folderId`) and `import_catalog_entry`
(`entryId`, `workspaceId`, `version?`). The search/read tools enforce catalog
visibility directly, including for consumers without membership in the source
workspace. Import and mutation tools retain destination/source role and key-scope
checks. Lifecycle changes appear in the workspace audit log without snapshot data.
