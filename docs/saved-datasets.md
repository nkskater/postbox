# Saved datasets

Open **Datasets** in the sidebar to create a named workspace dataset. Import CSV,
JSON records, XLSX/XLS, or a Postbox dataset package, or edit the grid directly.
CSV validation rejects duplicate/blank headers and surplus fields; short rows are
padded with empty strings and show warnings. Each save creates an immutable data
version. Name and description can also be updated independently through automation.
Old versions remain available; editing one creates a new latest version.

In the collection runner or schedule editor, select a saved dataset and choose
**Latest when the run starts** or a fixed version. Preview the first five rows and
variable columns, available as `{{column}}` and `pm.iterationData.get("column")`.
The runner's automatic iteration count and a schedule's count of `0` use one
iteration per dataset row. A positive count overrides that and repeats rows when
necessary. Uploaded runner files and filters still work when no saved dataset is
selected. Saved sources are resolved on the server after queue admission; the run
records the exact version used, including in retained history after deletion.

Mark sensitive columns explicitly. Credential-like imported column names are
suggested as secret; review the checkboxes before saving. Default previews mask
these cells. Runs redact their literal, URI/JSON-escaped and base64 values from
logs/results, and classify persisted variable copies as secret. Editing fetches
raw values only after an explicit **Edit as new version** action by a workspace
editor/owner. They remain hidden in password inputs unless **Show secret values**
is checked. Dataset content is not saved in browser storage. Saved values share
the SQLite database's storage protection; this is not an encrypted vault.

Exports contain one selected version and omit secret values by default, marking
`missingSecrets: true`. Importing that package preserves the marker and refuses
execution until an editor supplies the values (or explicitly acknowledges blank
values) and saves a new version. **Include secret values in export** is an explicit
opt-in requiring write access. Such a file contains credentials. A dataset can be
deleted only after all schedule references (including disabled schedules) are
detached and queued/running jobs finish or are cancelled. Historical runs retain
the dataset name/version, but do not prevent deletion.

All operations use the existing session or bearer-token authentication. Viewers
may read masked data and safe exports; editors/owners may create/change/delete
and explicitly read/export raw values. References must belong to the run or
schedule's workspace. Limits: 100,000 rows, 200 columns, 1,000,000 cells, 20 MiB
serialized content/imports, and 10,000 marked secret cells.

## REST

| Method and path                   | Input / behavior                                                                                                                              |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/datasets?workspaceId=…` | List names, latest versions, row counts and columns without cell values.                                                                      |
| `POST /api/datasets`              | `{workspaceId,name,description?,table:{columns,rows},secretColumns?,missingSecrets?}`; returns version 1.                                     |
| `GET /api/datasets/:id`           | Optional `version`, `previewRows=1..1000`, `includeSecrets=1`; includes active/schedule references. Default masks secrets.                    |
| `PATCH /api/datasets/:id`         | `{name?,description?}`; leaves immutable data versions untouched.                                                                             |
| `GET /api/datasets/:id/versions`  | Version metadata without cells.                                                                                                               |
| `POST /api/datasets/:id/versions` | `{expectedVersion,table,secretColumns?,missingSecrets?,name?,description?}`; `409` on stale latest version.                                   |
| `DELETE /api/datasets/:id`        | Deletes all versions; `409` while referenced.                                                                                                 |
| `POST /api/datasets/import`       | `{workspaceId,format:"csv"\|"json"\|"package",content,name?,secretColumns?}`; returns dataset plus warnings. XLSX uses the UI's local parser. |
| `GET /api/datasets/:id/export`    | Optional `version`, `includeSecrets=1`; full version package, unaffected by preview row limits.                                               |

Pass `dataset: {id, version?}` to `POST /api/runs` or schedule creation/update.
It is exclusive with inline run `data`. Omit `version` for latest. Set run
`options.iterations: 0` (or omit it) to count saved rows. To detach a schedule,
patch it with `dataset: null` and a positive iteration count. Empty datasets and
packages missing secrets cannot run; disabled schedules may retain them while
being configured. Enabling or manually triggering validates runnable content.

Example:

```json
{
  "workspaceId": "workspace-id",
  "folderId": "collection-id",
  "dataset": { "id": "dataset-id", "version": 2 },
  "options": { "iterations": 0, "persistVariables": false }
}
```

## MCP

The same behavior is available through `list_datasets`, `get_dataset`,
`create_dataset`, `update_dataset`, `create_dataset_version`, `delete_dataset`,
`import_dataset`, and `export_dataset`. Use `datasetId` for existing datasets;
`get_dataset` includes version history and references. `includeSecrets: true`
requires write access. `run_collection` accepts `dataset: {id,version?}` exclusive
with `dataCsv`, `dataJson`, and `dataRows`. `create_schedule`/`update_schedule`
accept the same dataset reference and `dataset: null` detaches it. All schemas
are advertised through MCP tool discovery.
