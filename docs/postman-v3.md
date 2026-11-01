# Postman collection v3

Postbox imports and exports Postman's **v3 collection format** (the `$kind: "collection"` document described by the
[official v3.0.0 JSON Schema](https://schema.postman.com/collection/json/v3.0.0/draft-07/collection.json)) in addition
to v2.0/v2.1, which keep working unchanged. The import detects the version by itself.

## Import

Use **Import**, the CLI (`postbox import file.json -w <workspace>`), `POST /api/import` or the MCP import tool with a
JSON or YAML v3 document. Add `--preview` (or `"preview": true`) to see what would be created, and what would not
be kept, without saving anything:

```json
{
  "kind": "preview",
  "source": "postman-v3",
  "name": "Orders API",
  "folders": 2,
  "requests": 6,
  "variables": 3,
  "warnings": ["Orders API: Secret variable \"apiToken\" has no value in the file; it is imported empty"]
}
```

What is imported: the collection name, description, variables (with disabled and secret flags), collection, folder and
request scripts (`beforeRequest` and `afterResponse`, with or without the `http:` prefix), authentication (including
`inherit` and `noauth`), folders, HTTP requests with headers (and their `$type`), query parameters (disabled ones too),
path variables, every body type (raw text/JSON/XML/HTML/JavaScript, form data with files, URL-encoded, binary file and
GraphQL) and saved examples with their request and response.

What is reported instead of silently dropped (each warning names the item, for example `Orders / Create order`):

| Content                                                                      | Result                    |
| ---------------------------------------------------------------------------- | ------------------------- |
| GraphQL, gRPC, WebSocket, Socket.IO, MQTT, Kafka, MCP, AI and data requests  | Skipped                   |
| Script types other than HTTP before/after (`graphql:*`, `grpc:*`, `kafka:*`) | Skipped                   |
| Several credential sets with URL rules                                       | First set used            |
| An authentication type Postbox does not support                              | Treated as no auth        |
| Secret variables (v3 files hold no value, only a source such as a vault)     | Imported as empty secrets |
| Request settings (`strictSSL`, redirects, TLS options, …)                    | Not imported              |
| Environment references (`uses`), script package references                   | Not imported              |

Script code is only stored. It is never run during import.

## Export

`GET /api/export/collection/{id}?format=v3` (default is `v2.1`), `postbox collection export <id> --format v3`, or
**⋯ → Export (Postman v3)** on a collection. `includeCredentials=1` keeps credentials as in the v2.1 export.
`format=v3&report=1` returns `{ "collection": …, "diagnostics": […] }` as JSON, which is what the CLI uses to print
`note:` lines on standard error.

Exports are valid against the official schema (the test suite checks this). v3 cannot hold some things, and the report
says so: secret variable values are never written (the key is kept with `secret: true`), and Postbox contract
metadata and unsupported authentication types are left out.

## Migrating v2.1 to v3

Export an existing collection with `--format v3`, or import a v2.1 file and export it as v3. The test suite
checks that the migrated document imports to the same requests, bodies, authentication, headers, scripts,
examples and variables as the original, and that v3 → Postbox → v3 is stable.

## Not covered

Postman's v3 _project_ layout (a directory of YAML files with a manifest) is not read or written: only the
single-document form that the published schema describes. Git synchronisation (LAB-96) and request contracts
(LAB-85) are unchanged by this and will build on the same converters.
