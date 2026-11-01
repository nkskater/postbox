# Collection documentation

Open a top-level collection's settings and select **Documentation**. The preview
renders saved endpoints, inherited headers/authentication types, descriptions,
query parameters, bodies, collection variable names/types, response examples and
cURL/JavaScript fetch snippets. Search filters endpoint text. Descriptions and
example bodies are escaped text, including HTML and Markdown source; embedded
scripts, images and links are not executed or fetched.

Save collection/request changes first, then review the preview. Workspace owners
can choose a title and **Private** or **Public**, and select **Publish snapshot**.
Viewers and editors can preview/read but cannot publish or revoke. Publication
requires the owner's management scope when using an API key.

- Private pages require authentication and read access to the source workspace.
- Public pages allow anonymous reads by anyone with the link.
- Publishing captures a sanitized snapshot. Later collection edits do not change
  the page until an owner explicitly selects **Republish snapshot**.
- Republish increments the revision and retains the URL. Changing public to private
  immediately requires authentication on that URL.
- **Revoke publication** deletes the snapshot. Future reads/downloads/imports at
  its URL return 404. Publishing again creates a different URL. Previously
  downloaded content cannot be recalled.

The page's **Import into Postbox** action asks for an authenticated destination
workspace and an explicit **Import collection** click. It creates a new sanitized
collection, requiring destination write access and source membership for private
publications. A viewer cannot import into a workspace where they only have read
access. Anonymous visitors can sign in before importing. **Download collection**
exports a Postman v2.1 collection for review or import into another instance.
Credentials, variable values and scripts must be configured after import.

## Privacy and bounds

Publication uses a whitelist, rather than copying arbitrary collection metadata.
It omits all auth configuration values, variable values, pre-request/test scripts,
request settings, contract metadata, upload bytes and original requests attached
to examples. Sensitive header/query/body fields and known secret values are
redacted before truncation. Collection auth types remain documented. No request,
script or code snippet is executed while generating, previewing or reading docs.

Known secret variables from every environment in the source workspace are also
redacted. Mark credentials as secret variables and avoid embedding credentials in
descriptions or opaque unstructured text. Review the preview before publishing;
automatic redaction cannot identify every arbitrary credential.

Snapshots are limited to 500 requests, folder depth 32 and 2 MiB of serialized
JSON. Descriptions are limited to 8,192 characters, field values to 4,096, and bodies
to 32,768. Only five response examples per request and 200 fields per parameter or
header list are retained. Omitted binary bodies and truncated examples are marked.
Oversized snapshots fail without changing the previous publication. Retained
snapshot bytes count toward workspace storage usage.

HTML responses use a nonce-based content security policy, disallow external
resources, and use `Cache-Control: no-store`, `Referrer-Policy: no-referrer` and
`X-Content-Type-Options: nosniff`. The public login bypass matches only the exact
read route; imports and management routes remain authenticated.

Backups include publications. Restoring any backup leaves them disabled, even
when the backup includes credentials. An owner must review and republish, creating
a new URL; old public links remain invalid. Deleting a collection/workspace also
removes its publication.

## Optional custom hostname

The optional **Custom origin** accepts a bare HTTP(S) origin such as
`https://docs.example.com`. It changes the displayed publication link. Configure
DNS, TLS and a reverse proxy to serve the same Postbox instance at that origin;
Postbox does not provision DNS or certificates. The same read/import/access rules
apply on the custom hostname. To use the import action, route the application and
management APIs at that origin as well. Path, credential, query and fragment
components in the custom origin are rejected.

## REST and MCP

| Method / path                                             | Behavior                                                                                                                                   |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/folders/:id/documentation`                      | Publication metadata (or `null`) and `canPublish`; workspace read access.                                                                  |
| `GET /api/folders/:id/documentation?preview=1`            | Sanitized HTML preview of saved collection data; workspace read access.                                                                    |
| `PUT /api/folders/:id/documentation`                      | Owner publishes `{visibility,title?,customOrigin?,expectedRevision}`. New/revoked publications use revision 0; stale revisions return 409. |
| `DELETE /api/folders/:id/documentation`                   | Owner revokes the publication.                                                                                                             |
| `GET /api/documentation/:publicationId`                   | Read-only HTML; checks membership for private pages.                                                                                       |
| `GET /api/documentation/:publicationId?format=json`       | Sanitized snapshot plus title/revision/visibility.                                                                                         |
| `GET /api/documentation/:publicationId?format=collection` | Sanitized Postman collection download.                                                                                                     |
| `POST /api/documentation/:publicationId/import`           | Authenticated explicit import into `{workspaceId}`; creates a new collection.                                                              |

Publication metadata includes `id`, `path`, `folderId`, `title`, `visibility`,
`revision`, `customOrigin` and `updatedAt`. A path is relative to the instance;
prefix the custom origin when configured. Publication IDs are independent random
identifiers. Private access depends on workspace membership, not knowledge of an ID.

MCP exposes `get_collection_documentation` (`folderId`, returns preview snapshot
and metadata), `publish_collection_documentation` (`folderId`, `publication` with
the PUT fields), `revoke_collection_documentation` (`folderId`) and
`import_documentation_collection` (`publicationId`, `workspaceId`). Publish/revoke
are owner-only; imports require the same source/destination access as REST.
Publication lifecycle changes appear in the workspace audit log without snapshot
content or credentials.
