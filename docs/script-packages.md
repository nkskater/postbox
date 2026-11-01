# Reusable script packages

Open **Packages** in the sidebar to manage workspace scripts and see the approved
bundled library catalog. Choose **New package**, give it a stable lowercase name,
and export functions with CommonJS `exports` or `module.exports`:

```js
exports.assertOk = function () {
  pm.test("Shared status check", function () {
    pm.response.to.have.status(200);
  });
};
```

Saving creates immutable version 1. New source versions start **unapproved**.
A workspace owner must review the source and select **Approve version** before
requests can import it. Editors can create versions; viewers can read them.
Owners can revoke approval at any time. Revocation affects the next execution
snapshot; already admitted runs keep their resolved code.

Import the same package from requests in any collection in the workspace:

```js
const checks = pm.require("@team/shared-checks@1");
checks.assertOk();
```

`@team/name@<integer>` pins an immutable source version. `@team/name` selects the
latest version at execution admission; it fails if that latest version is not
approved, rather than silently falling back. Updating a package never changes
older pinned source. Names are immutable because saved scripts refer to them;
descriptions can be updated separately through REST/MCP. To fork older source,
select its version, edit it, and save a new latest version. Concurrent saves use
`expectedVersion` and fail with 409 rather than overwriting another version.

The module can call `pm`, access the current request's scopes, and import another
approved package using its local `require` or `pm.require`. Pin transitive imports
as well when reproducibility matters:

```js
const shared = require("@team/shared-checks@1");
module.exports = { run: () => shared.assertOk() };
```

Cyclic imports fail explicitly. Computed imports are supported if their resolved
specifier exists in the captured workspace snapshot. Saved collection/request
scripts and other package versions that mention a package are shown as references
and prevent deletion. Reference detection is conservative text matching, including
comments, and cannot discover all computed imports. A deleted or unapproved
module fails clearly on the next import.

## Approved bundled libraries

The catalog lists exact installed versions and license identifiers. Use its pinned
specifier, for example:

```js
const lodash = pm.require("npm:lodash@4.18.1");
const chai = pm.require("npm:chai@4.5.0");
chai.expect(lodash.sum([2, 3])).to.equal(5);
```

Chai, Postman Collection SDK, Buffer, Lodash and Ajv are bundled locally. Catalog
pins are checked at build time: dependency upgrades require reviewing and updating
the approved version catalog. Existing legacy `require('chai')`,
`require('postman-collection')` and `require('buffer')` continue to work.
No other npm registry, URL, filesystem, native module, Node built-in, package
installer, lifecycle script or host `require` is available. Unavailable versions
fail instead of fetching code. This is not a general npm installation facility.

## Execution and privacy

Packages execute inside the existing QuickJS script sandbox and share its memory,
stack, timeout, network-host and host-call limits. Module initializers are bounded
by those same limits. Package helpers have the same `pm` capabilities as the
request script that calls them; approving code does not grant additional access.

The server caches immutable source by workspace, package ID, version and SHA-256
hash (at most 128 entries). Approvals are checked on every admission. Evaluated
module exports are cached only inside the current script isolate; repeated
imports in that isolate return the same object. Each script phase and request
starts with fresh evaluated modules, so closure state cannot leak between requests.
A collection run captures approved source after queue admission; schedules and
nested saved requests use the same workspace resolver.

Source is limited to 64 KiB per version, and the workspace to 128 versions and
2 MiB of source. All source bytes cross into the sandbox as JSON; there are no
host object references. Syntax or initialization errors appear as script errors.
Use `pm.globals`, `pm.environment` or other runtime scopes for credentials; do not
embed them in shared source. Source is readable by workspace members, like other
request scripts. Existing execution-log secret redaction applies to package code.
Resolved variables and evaluated exports are never stored in the source cache or
browser persistence.

Packages and versions are included in application backups. Backups without
secrets scrub known credential values from source and recompute integrity hashes.
Restoring a backup revokes all package approvals, including credential-inclusive
backups; owners must review and approve restored code. Legacy backups without
package tables remain supported.

## REST and MCP

| Method and path                          | Behavior                                                                                                   |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `GET /api/script-packages?workspaceId=…` | Package summaries plus the bundled library catalog.                                                        |
| `POST /api/script-packages`              | `{workspaceId,name,description?,source,approved?}`; returns version 1. `approved:true` requires ownership. |
| `GET /api/script-packages/:id?version=…` | Source, hash, approvals, version history and references; defaults to latest.                               |
| `PATCH /api/script-packages/:id`         | `{description}`; name and versioned source remain unchanged.                                               |
| `POST /api/script-packages/:id/versions` | `{expectedVersion,source,approved?}`; default unapproved, 409 on stale latest.                             |
| `POST /api/script-packages/:id/approval` | `{version,approved}`; owner-only review/revocation.                                                        |
| `DELETE /api/script-packages/:id`        | Delete an unreferenced package and all versions; 409 while referenced.                                     |

MCP exposes `list_script_packages`, `get_script_package`,
`create_script_package`, `create_script_package_version`,
`update_script_package`, `approve_script_package` and `delete_script_package`.
Existing-resource tools use `packageId`. Schemas are advertised by tool discovery.
Normal workspace read/write/manage permissions apply. Existing request and runner
REST/MCP calls automatically resolve approved packages in their workspace. Local
CLI collection runs can use approved bundled libraries; workspace packages require
server-side execution through REST/MCP because the local CLI does not read the
application database.
