# Linked collections and OpenAPI synchronization

Open a saved collection's **Specification** tab and choose **Generate OpenAPI
specification**. Postbox creates a versioned OpenAPI 3.0.3 document in the same
workspace and links the existing collection to it. Generation uses saved request
contracts for parameter/body/response types. Without declared types it infers
basic schemas from request bodies and saved response examples. It retains path
templates, parameter descriptions, content types and complete text examples.
Incomplete/binary examples and unsupported authentication schemes are reported
as generation warnings. Requests with unsupported non-HTTP methods are skipped
with warnings. Duplicate method/path pairs are rejected for explicit correction.

Alternatively, open a saved OpenAPI document in **Specifications** and choose
**Generate linked collection**. Choose a historical version if needed. Relative
servers can use the optional HTTP(S) source URL; this supplies URL context and
never fetches the URL. References resolve from the saved bundle only. Generated
requests retain the existing operation → path → root server precedence and server
variable isolation. Inspect/open the linked collection from the specification.

One collection has one source link. One specification may generate several
independently linked collections. **Unlink specification** keeps both documents;
it removes only synchronization state. Deleting either endpoint removes its link.
Links, baselines and versions are retained in workspace backups and counted toward
storage quotas. Backups without secrets scrub link authentication snapshots in
addition to the normal collection credential scrubbing.

## Review drift before applying

Choose the target direction, then **Preview synchronization**:

- **Update collection from specification** compares the latest saved source to
  the last linked version and the current collection. Existing request IDs remain
  stable. New operations become requests; unlinked local requests remain untouched.
- **Update specification from collection** compares the generated collection
  description to the previous generated baseline and current saved source.
  Changes create a new immutable source version. Authored fields and vendor
  extensions outside the changed fields remain in the source.

A preview lists proposed additions, edits and removals without changing either
side. Concurrent changes to the same field are conflicts, displaying the last
linked value, current target and incoming value. Choose **Keep current target**
or **Take incoming change** for every conflict before **Apply reviewed changes**.
Keeping a conflict acknowledges that difference in the new baseline. A later
change can be reviewed again. Arrays such as headers, parameters, examples and
variables are compared as units, so independently changed arrays need an explicit
choice rather than silently combining possibly incompatible entries.

Scripts and execution settings are never replaced by generated request fields.
Custom headers, names, bodies, authentication, contracts and examples participate
in three-way comparison. Removing a request with scripts, custom settings or saved
examples always requires an explicit choice. A locally deleted request stays
deleted when its source is unchanged; a source edit to it becomes a conflict.
Empty generated tag folders are retained to preserve folder customizations.

Previews carry a hash of the source, collection and link state. Any intervening
edit invalidates the token, including a script or variable edit. Apply returns
409 and requires a new preview. Repeating an unchanged synchronization does not
create source versions, replace request IDs or advance the link revision.

Operation identity uses `x-postbox-request-id` for collection-generated documents,
otherwise a unique `operationId`, otherwise method plus path. Keep operation IDs
stable across path renames. Changing an operation's identity is reviewed as a
removal/addition; customized removals still require a conflict choice.

## Scope and limits

Synchronization uses saved state. Save or discard source/collection settings
before using it. Other open request tabs may still contain unsaved editor state;
synchronization cannot include those changes until they are saved.

Source-to-collection generation accepts supplied multi-file bundles.
Collection-to-source updates require a single-file specification so they do not
rewrite unrelated files or leave broken external references. Original source
schemas remain authoritative. Generated request contracts project the validator's
supported schema subset; recursive/oversized or unsupported constraints produce
warnings instead of being silently represented as full validation support.
Source-only schema metadata remains in the saved specification across unchanged
round trips. Use the specification/compiler for complete standards validation.

Generation allows at most 1,000 requests/operations, collection depth 60 and a
1 MiB generated document. Existing specification bundle limits also apply.
Previews are capped at 2,000 changed fields and 200 conflicts. Response examples
are limited to 100 per request and 1 MiB each. No generation/synchronization step
runs scripts or sends API requests. Known credential values and sensitive example
fields are redacted from generated source; credentials are represented by security
schemes and variable references. Review authored examples and schemas before
sharing exported specifications.

## REST and MCP

Normal workspace/token scopes apply. Readers can inspect links and preview; write
access to both endpoints is required to apply. These app routes are outside the
v1 management OpenAPI inventory.

| Method | Path                                  | Input / result                                                |
| ------ | ------------------------------------- | ------------------------------------------------------------- |
| GET    | `/api/folders/ID/specification`       | Current source link or null                                   |
| POST   | `/api/folders/ID/specification`       | Generate/link source: optional `name`, `apiVersion`; 201      |
| DELETE | `/api/folders/ID/specification`       | Unlink, retaining both endpoints                              |
| GET    | `/api/specifications/ID/collections`  | List linked collections                                       |
| POST   | `/api/specifications/ID/collections`  | Generate collection: optional `version`, `sourceUrl`; 201     |
| POST   | `/api/specifications/ID/sync/preview` | `{folderId, direction}` → token, changes, conflicts, warnings |
| POST   | `/api/specifications/ID/sync/apply`   | `{folderId, direction, token, choices}` → applied result      |

`direction` is `collection` or `specification`. `choices` maps exact conflict paths
from preview to `keep` or `take`; no arbitrary content is accepted in an apply.

MCP tools: `get_collection_specification`, `generate_collection_specification`,
`unlink_collection_specification`, `list_specification_collections`,
`generate_specification_collection`, `preview_specification_sync`,
`apply_specification_sync`. ID arguments are `folderId` / `specificationId`;
generation settings go under `options`. Preview/apply take the REST fields
directly. Read-only MCP mode excludes generation, unlink and apply mutations.

References: [OpenAPI 3.0.3](https://spec.openapis.org/oas/v3.0.3.html) and
[Postman collection/specification synchronization](https://learning.postman.com/docs/design-apis/collections/generate-specifications/).
