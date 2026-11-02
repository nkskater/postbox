# API specification workspace

Open **Specifications** in the sidebar. Create a document, choose a format and
edit the source directly, or import source files. Add relative paths for supporting
files and choose an entrypoint. **Validate draft** analyzes the current editor
contents without saving or executing requests. Diagnostics include file, line and
column. The reference list shows resolved/missing targets; the documentation
preview lists operations, channels, types, messages or shapes and their details.
Descriptions are displayed as text, including HTML-looking input.

**Save specification** retains the original text, including whitespace and invalid
drafts. **Save new version** creates an immutable version with an optional label.
Select a saved version to inspect its original files and diagnostics. Saving an
older version creates a new latest version; it never rewrites history. Concurrent
updates require the current revision and return 409 if another editor saved first.
Unsaved changes prompt before switching documents or importing a bundle.

## Formats

| Format   | Sources and analysis                                                                                                                                 |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAPI  | JSON/YAML, OpenAPI 3.x or Swagger 2.0; source syntax, required header/operation fields, JSON pointer references, operation/schema outline            |
| AsyncAPI | JSON/YAML, 2.x publish/subscribe or 3.x operations; source syntax, header/action/channel checks, JSON pointer references and channel/message outline |
| GraphQL  | SDL across supplied files; GraphQL parser/schema diagnostics, type references and type/field/enum/union documentation                                |
| Protobuf | `.proto` sources; protobuf parser/type/import resolution, service methods, message fields and enums; bundled Google well-known imports are available |
| Smithy   | Smithy 2 IDL or canonical JSON AST; syntax/shape/member target checks, service/operation/type outline and documentation traits                       |

Validation is an editor diagnostic and reference pass, not a replacement for every
format's full standards/governance compiler. In particular, Smithy trait semantics,
resource binding/mixin expansion and protocol-specific constraints require the
Smithy toolchain; this editor retains their source. The Smithy reader accepts
shape declarations, namespace/use, traits, members/defaults, operation input/output,
metadata and JSON AST. Syntax it cannot interpret produces a diagnostic rather
than a successful validation result. Protocol execution remains in the request
editors. Saving a specification does not generate requests, deploy a service or
synchronize a collection.

References resolve only from supplied files; editing/validation does not fetch
URLs or read the server filesystem. OpenAPI/AsyncAPI external references must
have a matching relative file in the bundle. Cyclic JSON schema pointers can be
inspected without recursive expansion. GraphQL files form one SDL schema.
Protobuf imports use the supplied root-relative import paths. Smithy files merge
shapes by fully qualified ID; the standard scalar prelude is available.

Format references: [OpenAPI](https://spec.openapis.org/oas/latest.html),
[AsyncAPI](https://www.asyncapi.com/docs/reference/specification/v3.0.0),
[GraphQL SDL](https://graphql.org/learn/schema/),
[Protocol buffers](https://protobuf.dev/programming-guides/proto3/),
[Smithy IDL](https://smithy.io/2.0/spec/idl.html) and
[Smithy JSON AST](https://smithy.io/2.0/spec/json-ast.html).

## Import, export and limits

**Import files** adds local files to the unsaved draft and asks before replacing
a matching path. Nested paths can be added using **New file path**. **Export file**
downloads the selected file exactly. **Export bundle** downloads a JSON object:

```json
{
  "format": "graphql",
  "entrypoint": "schema.graphql",
  "files": [{ "path": "schema.graphql", "content": "type Query { health: String! }\n" }]
}
```

**Import bundle** loads that structure into a new document or a draft with the
same format. It preserves paths and text; save explicitly to persist it.

Bundles allow 30 files, 1 MiB UTF-8 per file and 3 MiB total. File paths must be
relative with no parent segments, URL schemes or control characters. Analysis
limits include 60 nesting levels, 50,000 structured nodes/tokens per file, 200
diagnostics and 2,000 symbols/references. Truncated results are marked explicitly.
There are at most 100 specifications per workspace and 100 versions per document.
Source storage counts toward workspace storage quotas. Workspace backups retain
specifications and all versions. Deleting a specification removes every version.
Sources may contain credentials supplied by the author; review source bundles
before sharing or exporting backups.

## REST and MCP

These app APIs use normal Postbox authentication and workspace/API-token scopes,
outside the v1 management OpenAPI inventory. Readers can inspect/export/validate;
editors can create/save/delete. There are no public source or preview endpoints.

| Method | Path                                             | Behavior                                                                             |
| ------ | ------------------------------------------------ | ------------------------------------------------------------------------------------ |
| GET    | `/api/specifications?workspaceId=ID`             | List names, formats and revisions                                                    |
| POST   | `/api/specifications`                            | Create with bundle fields, `workspaceId`, `name`, optional `label`; 201              |
| GET    | `/api/specifications/ID?version=N`               | Get latest or historical files, diagnostics, references, preview and version list    |
| GET    | `/api/specifications/ID?version=N&export=bundle` | Download the source bundle                                                           |
| PATCH  | `/api/specifications/ID`                         | Save new version: `expectedRevision`, `entrypoint`, `files`, optional `name`/`label` |
| DELETE | `/api/specifications/ID`                         | Delete document and all versions                                                     |
| POST   | `/api/specifications/validate`                   | Unsaved analysis with bundle fields and `workspaceId`                                |

MCP tools: `list_specifications`, `get_specification`, `create_specification`,
`save_specification`, `delete_specification`, `validate_specification`. ID-based
tools use `specificationId`; `save_specification` takes the PATCH object as
`patch`. `get_specification` accepts optional `version`. Read-only MCP mode
exposes list/get/validate and excludes source mutations. Returned files from
`get_specification` can be exported using the documented bundle structure.
