# SCIM provisioning

Use `/api/scim/Users` and `/api/scim/Groups` to provision Postbox accounts and workspace roles. Authenticate with a full-scope administrator API token and provide `?workspaceId=<id>`. Read-only, run and write tokens cannot provision accounts. Account state is global: deactivating a user ends access to every workspace.

The collection endpoints accept GET (filter, sort, pagination) and POST. Individual `/Users/{id}` and `/Groups/{id}` endpoints accept GET, PUT, PATCH and DELETE. Responses use `application/scim+json` and `schemas` arrays; DELETE returns an empty 204 response. See [SCIM schemas](https://www.rfc-editor.org/rfc/rfc7643.html) and [SCIM protocol](https://www.rfc-editor.org/rfc/rfc7644.html).

Users require a local Postbox `userName` (2–64 letters, digits, dots, underscores or hyphens). New users join the workspace as viewers. A password is optional; PUT/PATCH password changes revoke existing access. Setting `active` to false disables the account and revokes its sessions and API tokens immediately. `active` also accepts the strings `"true"` and `"false"` in any case, as Microsoft Entra ID sends them; any other value is a 400. Reactivation does not restore revoked tokens. DELETE disables the account and retains a tombstone; subsequent reads return 410 and the username remains reserved.

Groups accept the standard `displayName`; the optional Postbox `name` field can provide a separate role-mapping name. Names `Owners`, `Editors` and `Viewers` map to workspace roles, case-insensitively. Other names record membership only. Adding members applies the mapped role; removing them or renaming the group releases the previous role when it still matches. Explicit updates to another mapped group can replace a member's role. Group mutations are atomic, including role updates. A change that would remove the last workspace owner returns 409 and rolls back.

PATCH supports case-insensitive `add`, `replace` and `remove` operation names. Add and replace may omit `path` when `value` is an object of attributes. Filtered removal supports paths such as `members[value eq "user-id"]`; unsupported filtered add/replace operations return 400. Invalid attribute types are rejected. PUT replaces omitted optional profile fields.

Lists accept `startIndex` (one-based), `count`, `filter`, `sortBy` and `sortOrder`. Example: `/api/scim/Users?workspaceId=ws-id&filter=userName%20eq%20%22alex%22`. Provisioning changes are audited with passwords and profile contents redacted.
