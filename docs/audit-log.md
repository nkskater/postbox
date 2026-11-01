# Audit log

Postbox records who changed what, and when. History records the requests you send; the audit log records changes
to your workspaces and your instance.

## What is recorded

- Content: creating, updating and deleting requests, folders, environments, datasets, mocks, schedules and
  workspaces, from the app, the REST API or MCP tools.
- Access: workspace members added, removed or given another role, with the previous role.
- Accounts: users created, enabled, disabled, promoted, demoted, password changes and revoked access; service
  accounts; API keys created, rotated and revoked.
- Instance: settings changes, backup exports, restores, and cleared data; sign-ins and failed sign-ins.
- Refused changes: a change attempted without permission is recorded with the result `denied`.

Each event has the person (or service account, or environment credentials), how they signed in (session, API key,
MCP), the key used, the time, the workspace, the action (`request.update`, `member.role_change`, …), the entity,
a revision number counting that entity's recorded events, and the changes.

## No secrets

Events never contain secret values. A change lists the fields that changed. Only plain fields (names, methods,
roles, scopes, settings that are numbers, switches or choices) show before and after values. Everything else, such
as headers, bodies, authentication, variable values and passwords, is listed as "changed" without its value. URLs
lose credentials and query values. API keys are never stored in the log.

## Reading the log

- **Administrators:** Settings → Audit log, covering every workspace.
- **Workspace owners:** Settings → Workspace sharing → Activity, for that workspace only.

Filter by text, person, action group, result and dates. Use **CSV** or **JSON** to download every matching event
(up to 50,000). Exports are recorded in the log too.

```bash
curl -H "Authorization: Bearer pbx_…" "http://localhost:3000/api/admin/audit?action=member&limit=100"
curl -H "Authorization: Bearer pbx_…" "http://localhost:3000/api/admin/audit?export=csv&from=2026-01-01" -o audit.csv
curl -H "Authorization: Bearer pbx_…" "http://localhost:3000/api/workspaces/<id>/audit?kind=request"
```

Filters: `actor`, `action` (exact or a prefix such as `request`), `kind`, `entityId`, `result` (`ok` or `denied`),
`from`, `to` (dates or milliseconds), `q`, `workspaceId` (admin route), `limit` (up to 1000) and `cursor` (the
`next` value of the previous page). Keys need full scope to read the log.

## Retention

Events are kept for 365 days by default. Change it under Settings → History & data → Keep the audit log for
(0 keeps them forever). Events outlive the things they describe: deleting a workspace or a user does not delete
their trail. Restoring a backup does not touch the audit log.
