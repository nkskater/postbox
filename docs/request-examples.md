# Saved request-response examples

Open a saved request and choose **Examples**, or choose **Manage examples** from its sidebar action menu. The dialog lists examples in their saved order and shows the paired request template and response.

- **Create example** starts a custom pair from the parent's current saved request. Edit the name, method, URL, query parameters, request headers/body, and response status, headers/body. **Save example** (or Ctrl/Cmd+S) persists it independently of the parent request draft. Expand **Request template** to edit its fields.
- Select an example to open it. Editing its name renames it when saved. **Duplicate example** copies the saved pair with a new identity; **Move up/down** changes its order. Save or discard pending edits before duplicating or reordering. **Delete example** confirms deletion and removes only that example.
- **Try request** opens the example's request template in a new request tab without sending it or overwriting the parent. Collection context supplies variables and inherited configuration. Examples contain no request scripts; inherited collection scripts apply when you explicitly send the new request. Upload files need reattaching before execution.
- Closing, switching examples, creating another example, reloading, or trying a request prompts before discarding unsaved changes. Bulk header edits are included in this protection. The browser also warns on navigation/reload while an example has unsaved edits. Switching workspaces preserves the open example draft; switch back to its workspace before trying the request. Example edits are kept in memory until saved, rather than browser storage.

**Save as example** in the response panel captures the template used for that response, even if the request draft changed while the call was running or afterward. The response includes its captured status, headers and text or base64 binary body. Truncated captures are labeled. Older examples without a historical request snapshot remain readable; their current parent template is shown as a fallback. Editing the request fields captures that template explicitly.

Examples are bounded to 100 per request, 5 MiB of decoded response bytes each, and 20 MiB of total serialized example content per request. HTTP statuses must be 100–599. Response header names must be HTTP tokens; values and status text cannot contain line breaks or NUL. Base64 bodies must use valid padded base64. Text/HTML bodies remain plain editor text and are never executed in the example dialog.

## Retention and compatibility

Snapshots retain templates rather than resolved variable values. The existing retention rules apply on server writes/reads, imports, exports and browser draft storage: recognized credential fields, scoped secret values and known literal/encoded echoes are redacted. Snapshot auth credentials and uploaded file bytes are omitted; file metadata remains available for reattachment. Binary response content containing recognized sensitive values is omitted with `bodyOmitted: true`. Redaction cannot identify arbitrary unmarked secrets; inspect example content before sharing it.

Examples are stored in the request's existing JSON field, so existing requests require no SQL migration. Saving an ordinary request draft does not replace its examples. Example operations update only that field atomically. The editor sends an optimistic version; if another client changes the examples, save returns a conflict and preserves the local draft until you choose **Reload examples**.

Postman v2.0/v2.1 response `originalRequest` fields import/export as distinct request snapshots, including method, raw URL/parameters, headers, supported body modes, named GraphQL operations, auth configuration and description. Recognized credentials and file bytes remain omitted. Response disabled headers and descriptions are preserved. Postman's textual response model uses an optional `_postbox` extension to round-trip `bodyEncoding`, `bodyOmitted` and `truncated` metadata; other clients may ignore that metadata. Legacy examples without `originalRequest` continue to round-trip without inventing a historical request.

This request/response pairing follows the workflow described in [Postman's examples documentation](https://learning.postman.com/docs/use/send-requests/response-data/examples/). The shared `ResponseExample` / `ExampleRequest` model can also be consumed by mocks and documentation features.

## REST and MCP

`GET /api/requests/{requestId}/examples` returns `{ "examples": [...], "version": "opaque-version" }` and requires workspace read access. `POST` to the same endpoint requires write access and accepts:

```json
{
  "expectedVersion": "version-from-GET",
  "mutation": {
    "action": "create",
    "example": {
      "name": "Accepted",
      "status": 202,
      "statusText": "Accepted",
      "headers": [{ "key": "Content-Type", "value": "application/json", "enabled": true }],
      "body": "{\"accepted\":true}",
      "originalRequest": {
        "method": "POST",
        "url": "{{baseUrl}}/jobs",
        "params": [],
        "headers": [],
        "body": { "mode": "raw", "language": "json", "raw": "{\"job\":\"example\"}" },
        "auth": { "type": "inherit" }
      }
    }
  }
}
```

The server assigns `id` and `createdAt`. `originalRequest` is optional for legacy compatibility. Other mutations use the following shapes:

```json
{"action":"update", "exampleId":"id", "changes":{"name":"Renamed", "status":200, "body":"done"}}
{"action":"duplicate", "exampleId":"id", "name":"Optional copy name"}
{"action":"delete", "exampleId":"id"}
{"action":"reorder", "exampleIds":["second-id", "first-id"]}
```

Reordering requires every current ID exactly once. Updates replace supplied snapshot/header/body fields; omitted fields remain unchanged. A successful operation returns `{ "examples": [...], "version": "new-version", "example": {...} }`; `example` is included for create/update/duplicate. Missing request/example IDs return 404, invalid data/order returns 400, and a stale supplied version returns 409. `expectedVersion` is optional for automation that deliberately applies to the latest list. Workspace viewers can read; owners/editors can mutate; other workspace users cannot access the resource.

MCP exposes identical behavior through `list_request_examples({requestId})` and `manage_request_examples({requestId, command: {expectedVersion, mutation}})`. Errors return `isError: true`. The existing request API can still read or explicitly replace the whole example array; granular operations avoid replacing unrelated examples. Request/folder/workspace deletion removes the associated example JSON with its owning request, and request duplication copies the pairs into the new request's independent example list.
