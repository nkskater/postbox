# Thunder Client migration

Use the Import dialog, `POST /api/import`, or MCP `import_spec` with a native
Thunder Client collection or environment JSON export. Enable the credential
checkbox or pass `includeCredentials: true` explicitly: auth and variable values
may contain secrets. Consent defaults off and resets when the dialog closes.
Imports do not send requests, read referenced files, or populate the cookie jar.

Native `client` and `clientName` markers and version envelopes 1.0–1.4 are
recognized. Future version markers, malformed exports, missing/duplicate folder
IDs, conflicting parent links and cycles are rejected before persistence.
Extension storage database bundles are not native single-collection exports.

Folder links and `sortNum` determine hierarchy and sibling order. Collection and
folder auth, headers and base URLs are inherited; request auth and enabled headers
can override them. Disabled headers retain enabled inherited values. Native
path parameters are encoded, query table values already mirrored in the URL are
not duplicated, disabled query rows are removed from the executable URL, and URL
fragments are retained. Descriptions and body text stored as line arrays are
joined with newlines. Collection/environment variable values and secret/disabled
flags are preserved, including `{{variable}}` references.

Basic, digest, bearer, API-key, inherit and none auth are mapped. Existing OAuth
access tokens can become bearer auth with a warning; token refresh requires
configuration. Unsupported auth is disabled and reported. Raw JSON/XML/HTML/text,
URL-encoded forms, multipart text, GraphQL and binary placeholders are mapped.
Binary files must be selected locally after import. Multipart file references
without exported bytes reject conversion rather than importing empty uploads.

Source tests and scripts are not executed or translated; warnings explain that
they need rewriting with Postbox's APIs. Unsupported transport settings are also
reported. The dialog retains a scrollable warning list, and REST/MCP results
include `warnings`. Collection size is bounded to 10,000 items, folder nesting to
50 levels, and warning output to 200 entries.

Format references: [Thunder Client export documentation](https://docs.thunderclient.com/features/import)
and the native [Miniflux collection artifact](https://github.com/miniflux/v2/blob/main/contrib/thunder_client/collection.json).
