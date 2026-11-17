# Switching feature areas off

Postbox includes many areas beyond the API client itself. An administrator can switch off the ones
a server does not need under **Settings → Features**, or pin a switch with an environment variable.
Every area is on by default.

When an area is switched off:

- its sidebar tab, editor tabs, panels and settings are hidden (an open tab of the area explains
  that it is switched off);
- its REST routes, and public endpoints such as `/mock/…`, answer `404` with a message saying the
  area is switched off;
- its MCP tools are left out of `tools/list`, and `tools/call` refuses them;
- its background work stops (see the table).

Its data stays in the database: switching the area back on brings everything back as it was.
Backups still include it.

The core API client cannot be switched off: workspaces, collections and requests (all protocols),
the collection runner and schedules, pre-request and test scripts, variables, secrets and the vault,
environments, cookies, history, import and export, code snippets, accounts and administration, and
the MCP server itself. The managed gateway keeps its own `GATEWAY_ENABLED` switch.

| Area                                 | Environment variable             | Also stops                                                       |
| ------------------------------------ | -------------------------------- | ---------------------------------------------------------------- |
| AI assistant and AI requests         | `POSTBOX_FEATURE_ASSISTANT`      | Requests with the AI body type                                   |
| Production telemetry                 | `POSTBOX_FEATURE_TELEMETRY`      | Telemetry retention                                              |
| Governance and scorecards            | `POSTBOX_FEATURE_GOVERNANCE`     |                                                                  |
| API specifications                   | `POSTBOX_FEATURE_SPECIFICATIONS` | The collection Specification tab and contract validation         |
| Monitors and private runners         | `POSTBOX_FEATURE_MONITORS`       | Monitor checks (their schedules pause) and alert email           |
| MCP client                           | `POSTBOX_FEATURE_MCP_CLIENT`     |                                                                  |
| API catalog and documentation        | `POSTBOX_FEATURE_CATALOG`        | Catalog publishing and documentation tabs                        |
| Dependency graph                     | `POSTBOX_FEATURE_GRAPH`          |                                                                  |
| Script packages                      | `POSTBOX_FEATURE_PACKAGES`       | Managing packages (scripts that already use one keep working)    |
| Mock servers                         | `POSTBOX_FEATURE_MOCKS`          | Public mock endpoints                                            |
| Datasets                             | `POSTBOX_FEATURE_DATASETS`       |                                                                  |
| Load testing                         | `POSTBOX_FEATURE_LOAD`           | The Load test mode of the runner                                 |
| Traffic capture                      | `POSTBOX_FEATURE_CAPTURE`        | The capture relay                                                |
| Credential broker                    | `POSTBOX_FEATURE_BROKER`         | Brokered calls                                                   |
| Comments, forks and merge requests   | `POSTBOX_FEATURE_COLLABORATION`  | Comment and fork tabs                                            |
| Collection releases and dependencies | `POSTBOX_FEATURE_RELEASES`       | The collection Sharing tab                                       |
| Visual workflows                     | `POSTBOX_FEATURE_WORKFLOWS`      | Workflow schedules (deployments stay enabled and resume when on) |
| Outgoing webhooks                    | `POSTBOX_FEATURE_WEBHOOKS`       | Queuing and sending deliveries (pending ones are sent when on)   |
| Incoming webhook listeners           | `POSTBOX_FEATURE_HOOKS`          | The `/hook/…` endpoints                                          |

A variable set to `false`, `0`, `no` or `off` pins the area off; `true`, `1`, `yes` or `on` pins it
on. A pinned switch cannot be changed in Settings. Changes in Settings apply to the next request;
background work of an area switched back on starts again without a restart.

Developers: every top-level `src/app/api` directory, sidebar view and MCP toolset must be listed as
core or in an area in `src/core/features.ts`; `tests/features.test.ts` fails otherwise.
