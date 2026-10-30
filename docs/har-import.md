# Importing HAR recordings

Choose a `.har` or JSON file in Import, paste a HAR 1.2 document, or send its
content to `POST /api/import`. The MCP `import_spec` tool accepts the same content.
Imported entries become editable requests in their original array order. Importing
does not send requests or populate the cookie jar.

The converter retains method, HTTP URL, ordered query values and headers,
representable request bodies, and response examples with status and headers.
Collection and request descriptions record the HAR version, creator, entry
number, capture start, duration and page reference. The URL query takes precedence
when HAR query metadata disagrees, with a diagnostic. Transport headers such as
Host and Content-Length are disabled so execution can regenerate them.

Credentials are sanitized by default. Recognized authentication, token, cookie,
password, API key, session, signature and credential fields are redacted. URL
userinfo is removed, and credential query parameters, headers and form fields
are disabled. The workspace cookie jar is disabled for imported requests.
Recognized values, decoded Basic credentials, and their base64 and URL-encoded
forms are also removed from echoed payloads and examples across the recording.
Review arbitrary text and application-specific fields before sharing an import;
field-based sanitization cannot identify every application's sensitive data.
Configure authentication explicitly before replaying a request.

Raw UTF-8 text, JSON, URL-encoded forms, and multipart text fields are supported.
Base64-encoded UTF-8 text is decoded. Requests with uncaptured file bytes,
unsupported encodings/charsets, invalid JSON, or bodies exceeding the 1 MB import
limit are skipped with diagnostics. Binary and unavailable response bodies retain
response metadata in an example labeled “body unavailable.” Captured multipart
boundaries are disabled so execution can generate a new boundary.

Import results include a `warnings` array with entry numbers and safe diagnostic
messages. The dialog stays open with a scrollable warning list; REST and MCP callers
receive the same diagnostics. Diagnostics are capped at 200 with an omitted count,
recordings are limited to 10,000 entries, and imports with excessive credential
data are rejected before persistence. A recording with no importable requests
fails without creating a collection.

The standalone CLI can execute a recording:

```sh
postbox run recording.har --reporters cli,json
```

Conversion diagnostics are written to stderr before execution. CLI execution is
an explicit replay action; importing through the dialog, REST or MCP only saves
the editable collection.
