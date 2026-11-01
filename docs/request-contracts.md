# Request contracts

Open a request's **Contract** tab to declare parameter constraints and JSON body
schemas. Edit the JSON, choose **Apply contract**, then save the request normally.
Apply validates the definition; it does not send the request. **Remove contract**
removes the constraints from the draft; save to persist that change.

```json
{
  "pathTemplate": "/pets/{id}",
  "parameters": [
    {
      "in": "path",
      "name": "id",
      "required": true,
      "description": "Positive pet identifier",
      "schema": { "type": "integer", "minimum": 1 }
    },
    {
      "in": "query",
      "name": "limit",
      "required": false,
      "schema": { "type": "integer", "minimum": 1, "maximum": 100 }
    },
    {
      "in": "header",
      "name": "X-Mode",
      "required": true,
      "schema": { "type": "string", "enum": ["fast", "slow"] }
    }
  ],
  "requestBody": {
    "type": "object",
    "required": ["name"],
    "properties": { "name": { "type": "string", "minLength": 1 } },
    "additionalProperties": false
  },
  "responseStatus": [200, 201],
  "responseBody": {
    "type": "object",
    "required": ["pet"],
    "properties": { "pet": { "$ref": "#/$defs/pet" } },
    "$defs": {
      "pet": {
        "type": "object",
        "required": ["id"],
        "properties": { "id": { "type": "integer", "minimum": 1 } }
      }
    }
  }
}
```

Use only the constraints appropriate for the operation: omit `requestBody` for a
bodyless request. An absent optional parameter is allowed. An empty supplied value
is checked against its schema. Header names are case insensitive. Repeated query
keys validate each scalar separately; an array schema receives the repeated values.
Parameter strings can be coerced to numbers and booleans **for validation only**;
request data and stored templates are unchanged. JSON body values retain their
types, so `"1"` fails an integer body constraint. `pathTemplate` describes the
pathname, excluding origin/query, with `{name}` segments. Parameter documentation
is rendered beneath the editor.

## When checks run

**Validate draft & examples** checks enabled draft parameters, explicit headers,
raw JSON body and all saved response examples without network access or scripts.
It uses the applied definition; apply pending definition edits first. Unresolved
`{{variables}}` are deferred, including JSON containing templates. Draft checks
cannot see inherited headers, authentication headers or pre-request script changes.

Normal HTTP execution validates the prepared request after pre-request scripts,
variable substitution, inherited headers and auth. It validates the captured
response before post-response scripts. Checks appear as `Contract: …` test results
and as diagnostics under **Last HTTP execution** in the Contract tab. Failures
fail collection/CLI execution just like assertion failures, but do not block the
HTTP send or stop response scripts. This is request authoring and contract testing,
not validation of Postbox's own management API inputs. Streaming and non-HTTP
protocol sessions do not run these HTTP contract checks.

Diagnostics include location and violated constraint keyword, without observed
values or enum literals. Deferred checks are shown separately and do not count as
passing tests. Omitted, binary or truncated example/response bodies cannot be
validated in full and are deferred. No request is replayed to validate an example.

## Schema support and limits

Schemas use a bounded JSON Schema draft-07 subset: `type`, `properties`, `required`,
`additionalProperties`, `items`, `enum`, `const`, `minimum`, `maximum`,
`exclusiveMinimum`, `exclusiveMaximum`, `multipleOf`, `minLength`, `maxLength`,
`minItems`, `maxItems`, `minProperties`, `maxProperties`, `allOf`, `anyOf`, `oneOf`,
`not`, `title`, `description` and local `#/…` references. Both `definitions` and
`$defs` can contain referenced definitions. References resolve inside each parameter
or body schema, not across separate schemas. Unknown keywords, remote references,
formats, regex patterns and custom executable keywords are rejected. Schemas never
fetch resources. Tuple-style array items are unavailable; use a single items schema.

Contracts are limited to 100 parameters and 64 KiB of JSON. Each schema is limited
to depth 32 and 512 nodes including expanded local references (cyclic references are rejected), and observed JSON to 1 MiB and depth 64. Larger/deeper
observations are deferred. Schemas are cached in a bounded 64-entry cache; observed
values are never cached. Keep credentials in runtime scopes, not schema enum/const
literals. Backups include contract metadata; credential-free export/backup may
redact literals that match known secrets, so review restored constraints.

## REST, MCP and portability

`contract` is optional request metadata. Create requests through
`POST /api/requests` or patch through `PATCH /api/requests/:id` with the object above
under `contract`. Set `contract: null` to remove it. Reads return the definition.
Existing workspace write permissions apply to mutations.

`GET /api/requests/:id/contract-validation` returns:

```json
{
  "enabled": true,
  "request": [{ "location": "request.query.limit", "status": "passed", "message": "Matches schema" }],
  "examples": [{ "id": "example-id", "name": "Success", "diagnostics": [] }]
}
```

Statuses are `passed`, `error` or `deferred`. This endpoint requires workspace read
access and validates saved templates/examples without network access. MCP provides
`validate_request_contract` with `{requestId}` and the same result. `create_request`,
`update_request` and `send_request` accept `contract`; existing saved-request send
and collection runner tools automatically use stored contracts. Returned execution
results include `contractDiagnostics` as well as normal test results.

Duplication and application backups preserve contracts. Postman collection
export/import round-trips them in the item-level `_postbox.contract` extension.
Other clients may discard this extension. Local Postbox CLI collection execution
uses contracts imported from this extension with the same HTTP executor.
