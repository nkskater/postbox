# Hoppscotch migration

Import a native collection or environment JSON object, or an array of them, using
the Import dialog, `POST /api/import`, or MCP `import_spec`. Enable the dialog's
credential checkbox or pass `includeCredentials: true` explicitly. Exports may
contain authentication and secret variable values; no Hoppscotch content is
persisted without this consent. Closing the dialog resets consent.

The converter recognizes collection versions 1–12, REST request versions 0–17,
and environment versions 0–2, following the
[official versioned source schemas](https://github.com/hoppscotch/hoppscotch/tree/main/packages/hoppscotch-data/src).
Future versions are rejected. The core converter has no database or framework
dependencies. Batch exports are fully converted before an atomic persistence
transaction creates the collections and environments.

Folders, request names/descriptions, headers, parameters, bodies, variables and
supported authentication are mapped. Disabled header/parameter/form rows remain
disabled. `<<name>>` references become `{{name}}`; enabled query rows are included
in the executable URL. Variable values use current value, then initial value,
then the legacy value. Secret and disabled flags are retained.

Postbox stores variables at collection scope. Folder-level variable overrides
are assigned distinct generated names, and references within that folder are
rewritten to preserve resolution without overriding sibling requests. Imported
collection variables remain editable in Postbox's variable editor.

Basic, bearer, digest, API key and inherited authentication are supported. Legacy
OAuth bearer tokens are retained with a warning; interactive and advanced auth
flows require configuration in Postbox. Unsupported auth is disabled and reported.
Raw text/JSON/XML/HTML/URL-encoded bodies, multipart text fields and GraphQL
requests are mapped. Binary files require selecting the file after import;
uncaptured multipart file data and request-scoped variables reject conversion
rather than silently losing execution data. Imported requests do not use the
workspace cookie jar by default.

Hoppscotch scripts are not executed or translated. Recreate them with Postbox's
script APIs before relying on their behavior. Nonempty unsupported settings and
saved responses produce warnings. Warnings appear in the import dialog and the
REST/MCP result (`warnings`); batch results contain `items`. Conversion bounds
nesting to 50 levels, collection/request items to 10,000, and warnings to 200.
