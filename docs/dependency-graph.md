# Dependency graph

The dependency graph answers two questions about your APIs: **what does this rely on?** and **what is affected if it changes?** It is built from what Postbox already holds, so there is nothing to configure before opening **Dependencies** in the sidebar.

## What is indexed

| Source                           | What it adds                                                                                                                                                         |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Collections                      | The collection → folder → request tree; the host each request calls; the environments whose variables the URL uses; the specification operation each request matches |
| Specifications                   | The operations a specification defines and the hosts in its `servers`                                                                                                |
| Environments                     | A node requests can point at                                                                                                                                         |
| Mocks, monitors, catalog entries | The collection each one serves, runs or publishes                                                                                                                    |
| Webhooks                         | The host each one delivers to                                                                                                                                        |
| Capture sessions                 | Hosts seen in recorded traffic (telemetry, see below)                                                                                                                |

An edge `A → B` reads “A depends on B”. A folder depends on the requests it contains, a request on the service it calls, a monitor on the collection it runs. **Dependencies** of a node are what you reach following edges forward; **dependents** (its blast radius) are what you reach following them backwards.

Edge types: `contains`, `calls`, `usesEnvironment`, `implements`, `definedIn`, `servedBy`, `syncedFrom`, `mocks`, `monitors`, `publishes`, `observed`.

### What is inferred, and how

Every edge carries an **origin** and the **source** that produced it:

- `declared` — written down: a mock’s collection, a spec’s server list, a folder synced from a specification.
- `derived` — inferred: a request’s host after substituting environment, collection and global variables (every host a variable can take is linked, and the environments that supplied them), and which operation a request implements by comparing method and path against a specification (respecting the server’s base path and host).
- `telemetry` — observed on the wire in a capture session.

Only the **host** (and a non-default port) of a URL is stored. Credentials, paths, query strings and secret variables never enter the graph; a variable marked secret is not used to work out a host.

## Keeping it current

Changes are picked up automatically when the graph is read (at most once a minute per workspace). **Refresh index** forces it. Each source is fingerprinted, so a refresh rewrites only the sources whose facts changed and deletes sources whose collection, specification or monitor no longer exists.

Source states:

- `fresh` — indexed from its current state.
- `stale` — not re-checked for over a week.
- `error` — could not be read (for example a specification saved half-edited). The last good facts are kept, so dependents do not vanish, and the error is shown.
- `revoked` — a telemetry source that is not connected.

## Telemetry

Recorded traffic is only added when you **connect** a capture session in the Sources list (or `PATCH /api/graph/sources`). **Disconnect** deletes everything that session contributed. Connecting and disconnecting needs the workspace _manage_ role.

## Access

Everything is filtered by who is asking. You see your workspace’s graph if you can read it. Services are shared across workspaces by host, so a service you can see also shows the requests of other workspaces you can read — and nothing from workspaces you cannot. Remove someone’s access and those edges disappear from their view on the next query. API keys are limited by their scope as usual.

## REST

All routes take `workspaceId` and are outside `/api/v1`.

| Route                                                                                                  | Purpose                          | Role   |
| ------------------------------------------------------------------------------------------------------ | -------------------------------- | ------ |
| `GET /api/graph`                                                                                       | Counts and source states         | read   |
| `GET /api/graph/search?query=&kind=&limit=`                                                            | Find nodes                       | read   |
| `GET /api/graph/traverse?node=&direction=dependents\|dependencies\|both&depth=&types=&origins=&limit=` | Impact and dependency queries    | read   |
| `GET /api/graph/path?from=&to=&depth=`                                                                 | Shortest chain between two nodes | read   |
| `GET /api/graph/sources`                                                                               | Indexed sources and their state  | read   |
| `POST /api/graph/refresh`                                                                              | Re-index                         | write  |
| `PATCH /api/graph/sources` `{ sourceId, connected }`                                                   | Connect or disconnect telemetry  | manage |

Node ids look like `service:api.example.com`, `request:<id>`, `operation:<specId>:GET /pets/{id}`.

Example — everything affected if `api.example.com` changes:

```
GET /api/graph/traverse?workspaceId=…&node=service:api.example.com&direction=dependents&depth=5
```

The response lists reached nodes with their distance, the edges walked (type, origin, source) and a per-kind summary.

## MCP

`graph_search`, `graph_traverse`, `graph_path` and `graph_refresh` expose the same queries to agents. Searching first and then traversing from a returned id is the usual pattern.

## Not covered yet

Git repositories as sources (Postbox has no Git sync yet), production telemetry from monitors and runs beyond capture sessions, and links between workspaces other than shared hosts.
