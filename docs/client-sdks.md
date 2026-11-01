# Versioned client SDKs

Select an immutable catalog version in **Catalog**, choose **SDK language** and a
package name, then **Download SDK**. TypeScript downloads an npm `.tgz` with an ESM
runtime and `.d.ts` declarations. Python downloads a pure Python wheel containing
typed methods, TypedDict models and `py.typed`. Neither package runs installation
scripts or fetches dependencies. Catalog access rules and revocation apply to SDK
downloads as they do to documentation; credentials never grant access merely by
knowing a version number.

The selected catalog label becomes the SDK version. Downloads stay pinned to that
integer catalog version even when another version is published. Generated manifests
record the source SHA-256, SDK version, operations and normalization notes. The
server also returns artifact/source SHA-256 headers. The same source/options produce
the same bytes: no generation timestamps, random IDs or machine paths are included.

## Local collection and OpenAPI generation

```bash
postbox sdk generate api.yaml --language typescript --name pet_client --sdk-version 1.0.0 --out-dir generated --json
postbox sdk generate collection.json --language python --name pet_client --sdk-version 1.0.0 --out-dir generated
```

`--sdk-version` avoids the top-level `--version` flag, which reports the Postbox
version. `--out-dir` avoids the management CLI's `--output json|table` flag. The
artifact keeps its recommended filename, including Python's required wheel tags.
Existing artifacts are never overwritten. Generate into a different directory or
explicitly remove an old artifact yourself after review.

Inputs are Postman v2/v3 collections or OpenAPI/Swagger JSON/YAML. Same-document `#/…` schema
references are resolved without network access. External/remote references are
rejected; bundle them into one document before generation. Unsupported v3 conversion features
fail explicitly. Missing files return exit code 4; invalid source/options or an
existing destination artifact return 5; missing required CLI arguments return 2.
`--json` prints output path, filename, artifact/source hashes and operation names.

Package names are lowercase identifiers (letters, digits and underscores), up to
50 characters, starting with a letter. Names that shadow Python runtime modules or
keywords are rejected. Versions use three numeric components with an optional
alphanumeric prerelease suffix. Stable versions are identical in npm and Python.
Python prereleases use a `.dev0+sv<hex suffix>` PEP 440 form that uniquely preserves
the original prerelease; the manifest/README retain the requested SDK version.

## Install and use

```bash
npm install ./generated/pet_client-1.0.0.tgz
python3 -m pip install ./generated/pet_client-1.0.0-py3-none-any.whl
```

TypeScript/JavaScript requires Node 20+ or a modern browser with fetch. Python
requires 3.11+. Configure the base URL and runtime credentials explicitly:

```ts
import { Client, ApiError } from "pet_client";

const api = new Client({
  baseUrl: "https://api.example.test",
  auth: (request) => {
    request.headers.Authorization = `Bearer ${process.env.API_TOKEN}`;
  },
  onError: (error, request) => {
    // Map errors or record redacted diagnostics here; no automatic logging occurs.
    if (error.kind === "http" && error.status === 401) throw error;
  },
});
const pet = await api.get_pet({ path: { id: 7 } });
```

```python
from pet_client import Client, ApiError
import os

def authenticate(request):
    request["headers"]["Authorization"] = "Bearer " + os.environ["API_TOKEN"]

api = Client("https://api.example.test", auth=authenticate)
pet = api.get_pet(path={"id": 7})
```

Operation names are normalized from collection request names or OpenAPI operation
IDs. Names are listed in `sdk-manifest.json`; duplicate/reserved names get stable
suffixes/prefixes. All source requests are included or generation fails; unsupported
operations are not silently skipped. Paths encode each provided parameter, and
missing/unresolved path values fail. Queries use primitive values and repeated keys
for arrays. JSON, raw text and URL-encoded body modes are supported. Complex object query serialization, multipart/file
uploads, Swagger formData and GET/HEAD bodies require a custom client outside this
generator and fail explicitly. Non-HTTP protocols are not generated.

Source headers, query/body defaults, auth credential values, variable values,
scripts and examples are not embedded. Supply values through method options,
client headers or the auth callback. Authentication type is descriptive metadata;
all credential acquisition/signing remains caller-controlled. No source endpoint
requests or scripts execute during generation.

## Types, errors, transport and pagination

OpenAPI schemas and collection request contracts project structural response/body
models and typed query parameters. Types include primitives, objects, arrays,
nullable/unions and local references. Enum/default/example literals are omitted.
TypeScript retains nested structural object shapes; Python top-level objects use
TypedDict and nested objects use typed JSON dictionaries. This is static typing,
not runtime response-schema validation. Unspecified/unrepresentable/depth-limited
schemas use `JsonValue` explicitly. Catalog snapshots omit contract metadata, so
catalog SDKs use JSON value types where no schema is available; use a local
OpenAPI/contract definition for richer models.

`ApiError` distinguishes `http`, `network`, `decode` and `pagination` failures.
HTTP errors expose status and decoded body; network errors retain the cause.
The error hook sees request failures and may inspect or replace them by throwing.
There are no automatic retries or logs. Default timeouts are 30 seconds; configure
`timeoutMs` in TypeScript or `timeout` (seconds) in Python. TypeScript method options
also accept `AbortSignal`. A custom `fetch`/Python `transport` callback can replace
the network layer. Default clients refuse redirects to avoid forwarding runtime
authentication to a different target.

Pagination is an explicit bounded callback, not guessed from API response shapes:

```ts
for await (const page of api.pages(
  (options) => api.list_pets(options),
  { query: { page: 1 } },
  (value, previous, index) => (value.next ? { query: { page: value.next } } : null),
  100,
)) {
  // Consume each page.
}
```

```python
pages = api.pages(
    lambda options: api.list_pets(**options),
    {"query": {"page": 1}},
    lambda value, previous, index: {"query": {"page": value["next"]}} if value["next"] else None,
    max_pages=100,
)
```

Callbacks return the next options or null/None to stop. The default limit is 100
pages (configurable 1–10,000); exceeding it raises a pagination error. Callers choose
the operation, including whether repeating it has side effects. The auth hook runs
for every page/request.

## API and limits

`GET /api/catalog/:id?format=sdk&language=typescript|python&name=pet_client&version=N`
returns an attachment with `Cache-Control: no-store`, `X-SDK-SHA256`,
`X-Source-SHA256` and `X-Catalog-Version`. Omitting version deliberately selects
latest; the UI always sends its selected version. Package versions come from the
immutable catalog label. Private/team ACLs apply before generation; revoked or
unavailable versions return 404.

MCP `generate_catalog_sdk` accepts `{entryId,version?,language,name?}` and returns
filename, MIME type, artifact/source hashes, pinned catalog version/label, operation
names and base64 archive bytes. It obeys the same catalog visibility checks and is
available in read-only mode because it creates no persistent server data.

Sources/normalized definitions are limited to 2 MiB and 500 operations; artifacts
to 5 MiB. Structural projection is bounded by depth 12 and 10,000 nodes per model.
No package registry, remote schema fetch, compiler, install script or target API
runs on the server during generation. Packages include the Postbox runtime's MIT
license notice; API definitions and consumer code retain their own ownership.
