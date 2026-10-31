# Import OpenAPI documents with references

Open **Import → OpenAPI bundle** to import OpenAPI 3.x or Swagger 2.0 JSON/YAML. Choose files from one directory, choose a folder to preserve nested relative paths, paste a root document, or fetch a root URL. Folder selection keeps the selected directory name in the paths. Choose the root document in **Entrypoint**; `openapi` or `swagger` filenames are suggested automatically. Only JSON/YAML files are included from a folder.

For uploaded or pasted documents, **Original document URL** optionally supplies the root source URI. Uploaded files resolve against that URI without downloading them; missing files can then be downloaded only from explicitly approved origins. Without an original URL, relative references resolve exclusively within the supplied bundle. Postbox never reads references from its server filesystem.

**Preview OpenAPI** resolves the complete reference graph, reports counts and diagnostics, and creates no collections, requests, variables or environments. **Import OpenAPI** becomes available after a successful preview. Changing the source, entrypoint, original URL, workspace or approvals requires a new preview. An imported selection cannot be submitted twice in the same dialog. Remote documents are fetched again when importing, so the preview is informational rather than a retained snapshot.

## Reference behavior

- Relative references use the URI of the document containing them, including the final URL after redirects. JSON Pointer escaping and percent-encoded fragments are supported. OpenAPI 3.1 schema references honor nested `$id` resources and `$anchor` fragments; OpenAPI 3.0 and Swagger use document-relative references.
- A remote reference requires its exact HTTP(S) **origin** in **Approved reference origins**, even when it shares the root document's origin. Each reference redirect destination also needs approval before Postbox contacts it. A failed preview offers an explicit button to approve the reported origin, then preview again. Approval never overrides `PROXY_ALLOW_HOSTS` / `PROXY_DENY_HOSTS`; hostname and resolved IP restrictions apply at every exchange. Document downloads use no workspace cookies or authentication. URLs with embedded credentials are rejected.
- Recursive schemas remain references in the bundled graph, produce `cyclic-reference` warnings, and generate request samples only to the converter's existing depth limit (6). Reference-only cycles that cannot produce a sample fail conversion. Missing files, pointers or anchors fail the entire import with diagnostics; no partial collection is saved and unresolved references never become empty schemas.
- OpenAPI 3.1 schema assertion siblings of `$ref` are preserved with `allOf`. Older schema reference siblings are ignored with a warning. `$dynamicRef` is rejected explicitly because collection conversion requires static references. Literal example/default/enum data containing a property named `$ref` is kept as data and never downloaded.
- Existing server precedence remains operation → path → root. Relative server URLs from referenced files use their document's source URL. Path parameter example/default values become collection variables. JSON string samples are encoded as JSON strings.

This imports editable request snapshots, not a retained specification editor or schema validator. References used outside the generated request fields are still resolved and checked. Dynamic references and unsupported/malformed targets report failures instead of silently dropping schemas. Origins and reference targets in diagnostics omit URL credentials and query values.

## REST and MCP

`POST /api/import` and MCP `import_spec` share the same arguments and resolution behavior. REST also requires `workspaceId`; MCP defaults it to the primary workspace.

```json
{
  "workspaceId": "workspace-id",
  "files": [
    {
      "path": "project/openapi.yaml",
      "content": "openapi: 3.1.0\ninfo: {title: Pets, version: '1'}\npaths:\n  /pets:\n    post:\n      requestBody:\n        content:\n          application/json:\n            schema: {$ref: './models/pet.json'}\n      responses: {'200': {description: OK}}\n"
    },
    {
      "path": "project/models/pet.json",
      "content": "{\"type\":\"object\",\"properties\":{\"name\":{\"type\":\"string\"}}}"
    }
  ],
  "entrypoint": "project/openapi.yaml",
  "sourceUrl": "https://api.example/spec/openapi.yaml",
  "allowedRefOrigins": ["https://schemas.example"],
  "preview": true
}
```

Use `content` or `url` instead of `files`/`entrypoint` for a single root. Files are exclusive of content/URL. A fetched root uses its actual final URL; `sourceUrl` applies to uploads/pasted content. For compatibility, `url` takes precedence if both URL and content are supplied. Origins contain only scheme, hostname and optional port, with no path/query/fragment. `includeCredentials` retains its existing meaning for other collection formats; OpenAPI document downloads have no credential forwarding.

A successful preview returns HTTP 200:

```json
{
  "kind": "preview",
  "source": "openapi",
  "name": "Pets",
  "requests": 1,
  "folders": 0,
  "variables": 1,
  "references": { "documents": 2, "references": 1, "remoteFetches": 0, "cycles": 0, "providedFiles": 2 },
  "diagnostics": [],
  "warnings": []
}
```

Submit the same arguments with `preview: false` to save. REST returns HTTP 201 and `kind: "collection"` with the imported ID/counts and the same reference metadata. Resolution failures return HTTP 400 with `error` and `diagnostics`; MCP returns `isError: true` with the same JSON fields. Diagnostics contain `severity`, `code`, `source`, `path`, `message`, and optionally `target`/`origin`. An `origin-not-approved` diagnostic identifies the approval needed. Schema/input errors return the existing validation error format. SoapUI preview and legacy single-file imports remain available.

The synchronous `importOpenApi` converter accepts local JSON Pointer references or an already bundled document. External references must go through the shared asynchronous import pipeline (or `bundleOpenApiReferences` with an explicitly supplied loader); the synchronous converter fails on unresolved references.

## Limits

| Resource                                       | Limit per operation               |
| ---------------------------------------------- | --------------------------------- |
| Uploaded files / referenced documents          | 100                               |
| Each OpenAPI document                          | 5 MiB UTF-8                       |
| Uploaded plus remotely loaded document content | 20 MiB                            |
| HTTP exchanges, including root and redirects   | 20                                |
| Redirects per document                         | 5                                 |
| Each HTTP exchange                             | 5 seconds                         |
| Total loading/resolution/conversion            | 15 seconds                        |
| Document/expanded graph nesting                | 80                                |
| Reference chain                                | 64                                |
| References traversed                           | 2,000                             |
| Traversed graph nodes                          | 200,000                           |
| Diagnostics                                    | 200 (truncation fails explicitly) |

Encoded and decompressed download sizes are bounded. The API's existing 25 MiB JSON body limit also applies, including JSON escaping overhead. Invalid bundle paths, duplicate files/resource IDs, cyclic YAML aliases, unsupported URI schemes and invalid targets fail without writes. File bundle paths must be relative and cannot contain parent-directory segments; references may use `../` to reach another explicitly supplied file.

Reference semantics follow the [OpenAPI 3.1.1 specification](https://spec.openapis.org/oas/v3.1.1.html#relative-references-in-uris); folder imports address the workflow described in [Postman's import documentation](https://learning.postman.com/docs/getting-started/importing-and-exporting/importing-data).
