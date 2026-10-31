# Script compatibility

Postbox runs HTTP pre-request and post-response scripts in QuickJS. The same
executor powers the UI Send action, REST/MCP sends, collection runner, scheduler
and standalone CLI. This is a supported subset of the
[Postman sandbox API](https://learning.postman.com/docs/tests-and-scripts/write-scripts/postman-sandbox-reference/overview/),
not a claim of complete SDK or package compatibility. Remaining work is tracked
in [LAB-140](https://nkskater.atlassian.net/browse/LAB-140).

## API inventory

| API                                                      | Supported behavior and boundaries                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pm.globals`, `pm.environment`, `pm.collectionVariables` | `get`, `has`, `set`, `unset`, `clear`, `toObject`, `toJSON`, `replaceIn`; values are stored as strings. Environment changes require a selected environment to persist.                                                                                                                                   |
| `pm.variables`                                           | Resolution across scopes, local `set`/`unset`, `has`, `toObject`, `replaceIn`. Precedence: global, collection, environment, iteration data, local.                                                                                                                                                       |
| `pm.iterationData`                                       | Read access with `get`, `has`, `toObject`, `toJSON`, `replaceIn`. Mutation is unsupported.                                                                                                                                                                                                               |
| `pm.info`                                                | Event, request ID/name, iteration and iteration count.                                                                                                                                                                                                                                                   |
| `pm.request`                                             | Mutable method, URL string/`Url`, headers and basic body `update`; file contents are hidden. Auth SDK mutations and the full structured URL/body SDK are unsupported.                                                                                                                                    |
| Header/query lists                                       | `get`, `has`, `one`, `all`, `toObject`, `toJSON`, `each`/`forEach`, `map`, `filter`, `count`, `add`, `upsert`, `remove`, `clear`. Header keys ignore case; query keys preserve case. This is a basic list subset, not the full Collection SDK.                                                           |
| URL                                                      | `update`, `toString`, `getHost`, `getPath`, `getQueryString`, `addQueryParams`, `removeQueryParams`, `query`.                                                                                                                                                                                            |
| `pm.response`                                            | `code`, `status`, `headers`, `responseTime`, `responseSize`, cookies, `text`, `json`, `reason`, `dataURI`, `toJSON`, and basic status/header/body assertions. `stream` is text, not a Node Buffer.                                                                                                       |
| `pm.test`                                                | Synchronous, promise and `done` callback forms; `skip`; `index` counts declarations, including pending tests. Callback tests must finish or the script times out.                                                                                                                                        |
| `pm.expect`, `require("chai")`                           | BDD subset: equality, types, numeric bounds, includes, keys, properties, lengths, matches, throws, members and response assertions. Ordered and duplicate array member comparisons are covered. The `assert` shim is a truthiness function. Full Chai plugins and SDK extensions are unsupported.        |
| `jsonSchema` assertion                                   | Object schemas: type, enum, const, required, properties, boolean additionalProperties, items, numeric bounds, string length/pattern and array length. Unsupported constraint keywords fail explicitly instead of silently passing. Full draft validation, references and combinators remain unsupported. |
| `pm.sendRequest`                                         | Promise and callback forms, using current script variables, host policy and instance request defaults. No filesystem uploads.                                                                                                                                                                            |
| `pm.execution.runRequest`                                | Saved request ID, promise response, variable overrides, inherited scripts/auth/headers, child assertions and variable changes. See below.                                                                                                                                                                |
| `pm.execution.location`                                  | Collection/folder/request path; `.current` is the folder or request whose script is running.                                                                                                                                                                                                             |
| Flow control                                             | `setNextRequest` works in collection runs; `skipRequest` immediately stops a pre-request script and skips the remaining pre-request and post-response scripts. Calling it after a response fails explicitly.                                                                                             |
| Cookies                                                  | Snapshot `get`, `has`, `getAll`/`toObject` access. The HTTP engine manages the shared cookie jar; `pm.cookies.jar()` fails explicitly.                                                                                                                                                                   |
| Console/timers                                           | `console.log/info/warn/error/debug`, `setTimeout` and `clearTimeout`. Clearing a timer releases its wait. `setInterval` fails explicitly.                                                                                                                                                                |
| Legacy globals                                           | `postman` variable helpers/`setNextRequest`, `tests`, response globals, `environment`, `globals`, `data`, `request`, `btoa` and `atob`.                                                                                                                                                                  |
| Unsupported product APIs                                 | `pm.require`, vault get/set/unset, visualizer set, datasets, mock create, state get/set/unset/clear and streaming message text/json report unsupported behavior. Other `require` modules fail explicitly.                                                                                                |

## Execute a saved request

Copy a saved request's Postbox ID, then call it from either script tab:

```javascript
const response = await pm.execution.runRequest("saved-request-id", {
  variables: { customerId: "123" },
});
pm.test("lookup succeeded", () => pm.expect(response.code).to.equal(200));
```

Server sends and runs resolve IDs only within the current workspace. The
standalone CLI resolves Postbox IDs within the imported collection; imports
assign new IDs, so source Postman IDs must be updated. A helper request can save
its runtime ID with `pm.globals.set("helperId", pm.info.requestId)` before later
requests reference it.

The referenced collection's variables override the root collection's variables;
environment, data, local values and invocation overrides take precedence over
both. Overrides do not escape into the caller. Child global/environment/local
changes return to the calling script, while collection changes stay with their
owning collection. Server collection variable changes obey the run's
`persistVariables` option. Await calls whose ordering or variable changes matter.

A skipped reference returns `null`. A network failure rejects the promise; child
script errors and assertions appear with the root request's results. Child
`setNextRequest` does not change the root run's flow. Referenced executions do not
create separate history/run-result rows.

The host enforces at most ten saved-request calls per script, five nested
references and 100 referenced executions per root request. All host requests
also count against the script's host-request quota. Caller cancellation and script
timeouts abort nested HTTP work. Scripts cannot access Node APIs, the filesystem,
`fetch`, or arbitrary host objects. These limits remain enforced if scripts
replace their guest-side helpers.

## Conformance coverage

`tests/helpers/sandbox-conformance.ts` defines one deterministic contract for SDK
mutations, callbacks, child responses/assertions, scopes, location and isolation.
It runs through the UI's actual Send route, core collection runner and built
standalone CLI. Focused sandbox and saved-request tests additionally cover quota
bypass attempts, malformed scope snapshots, external cancellation, timeout
cleanup, workspace isolation, collection precedence and secret redaction.

References: [execution semantics](https://learning.postman.com/docs/tests-and-scripts/write-scripts/postman-sandbox-reference/pm-execution/),
[test APIs](https://learning.postman.com/docs/tests-and-scripts/write-scripts/postman-sandbox-reference/pm-test-expect/).
