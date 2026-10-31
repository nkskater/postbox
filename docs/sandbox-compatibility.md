# Script compatibility

Postbox runs HTTP pre-request and post-response scripts in QuickJS. The UI Send
action, REST/MCP sends, collection runner, scheduler and standalone CLI share the
same executor and conformance contract.

## API inventory

| API                                                      | Contract                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pm.globals`, `pm.environment`, `pm.collectionVariables` | `get`, `has`, `set`, `unset`, `clear`, `toObject`, `toJSON`, `replaceIn`; stored values are strings. Environment changes persist when an environment is selected.                                                                                                                                                                          |
| `pm.variables`                                           | Scope resolution, local `set`/`unset`, `has`, `toObject`, `replaceIn`. Precedence: global, collection, environment, iteration data, local; saved-request invocation overrides rank above local.                                                                                                                                            |
| `pm.iterationData`                                       | Read access with `get`, `has`, `toObject`, `toJSON`, `replaceIn`. Writes fail.                                                                                                                                                                                                                                                             |
| `pm.info`                                                | Event, request ID/name, iteration and iteration count.                                                                                                                                                                                                                                                                                     |
| `pm.request`                                             | Collection SDK Request, URL, auth, header and body objects. URL/auth/header/body mutations are serialized back into the shared execution pipeline. Existing string `body.update()` behavior remains supported. Attached file contents stay outside the sandbox. Script-added file bodies, proxy and certificate mutations fail explicitly. |
| `pm.response`                                            | Collection SDK Response, including binary Buffer stream, headers, cookies, text/JSON/JSONP, content information, sizes, data URI and response assertions.                                                                                                                                                                                  |
| `pm.test`                                                | Synchronous, promise and `done` callback forms, `skip`, and declaration-based `index`. Callback tests must finish or the script times out. Uncaught asynchronous callback/timer errors surface as script errors.                                                                                                                           |
| `pm.expect`, `require("chai")`                           | Chai 4.5.0 plus Postman's response assertion plugin 2.0.1, including full BDD/TDD assertions, deep Date/RegExp/Map/Set equality, ordered members, throw overloads and invalid-assertion errors.                                                                                                                                            |
| `jsonSchema` assertion                                   | Ajv 8.20.0 with formats. Supports draft-07 (default), 2019-09 and 2020-12, local references, combinators, boolean schemas and schema-valued additionalProperties. Unknown keywords/drafts fail explicitly. Remote/asynchronous schema loading is unavailable.                                                                              |
| `require("postman-collection")`                          | Collection SDK 5.3.1, including structured URLs, property lists, RequestAuth/RequestBody and response helpers. Deprecated methods retain upstream errors.                                                                                                                                                                                  |
| `Buffer`, `require("buffer")`                            | Browser Buffer implementation; no Node host objects cross into QuickJS.                                                                                                                                                                                                                                                                    |
| `pm.sendRequest`                                         | Promise and callback forms, accepting strings, request definitions or SDK Request objects, with current variables, configured auth, host policy and instance request defaults. No filesystem uploads.                                                                                                                                      |
| `pm.execution.runRequest`                                | Saved request ID, promise response, invocation overrides, inherited scripts/auth/headers, child assertions and variable changes. See below.                                                                                                                                                                                                |
| `pm.execution.location`                                  | Full collection/folder/request path. `.current` identifies the folder or request whose script is running.                                                                                                                                                                                                                                  |
| Flow control                                             | `setNextRequest` controls collection runs. `skipRequest` stops the current pre-request script, skips the remaining pre-request chain and sends no request. Calling it after a response fails. Child flow-control decisions do not alter the root run.                                                                                      |
| `pm.cookies`                                             | Case-sensitive `get`, `has`, `getAll`/`toObject` snapshot, restricted to cookies applicable to the request's domain/path/scheme. The HTTP engine manages cookie persistence; `jar()` fails explicitly.                                                                                                                                     |
| Console/timers                                           | `console.log/info/warn/error/debug`, bounded `setTimeout`/`setInterval`, `clearTimeout`/`clearInterval`. Clearing a timer releases its wait.                                                                                                                                                                                               |
| Legacy globals                                           | `postman` variable helpers/`setNextRequest`, `tests`, response globals, `environment`, `globals`, `data`, `request`, Latin-1 `btoa`/`atob`.                                                                                                                                                                                                |

Product capabilities with their own backlog stories remain explicitly unavailable
in scripts: vault access (LAB-75), package registry imports via `pm.require`
(LAB-77), visualizations (LAB-78), datasets (LAB-80), mocks (LAB-81), persistent
mock state (LAB-82), and streaming message APIs. Other `require` modules fail
explicitly. These calls cannot silently pretend to perform an unsupported action.

## Execute a saved request

Copy a saved request's Postbox ID and use it in either script tab:

```javascript
const response = await pm.execution.runRequest("saved-request-id", {
  variables: { customerId: "123" },
});
pm.test("lookup succeeded", () => pm.expect(response.code).to.equal(200));
```

Server sends and runs resolve IDs only within the current workspace. The
standalone CLI resolves IDs within the imported collection, including requests
excluded from the selected run. Imports assign new IDs, so source Postman IDs
must be updated. A helper can save its runtime ID with
`pm.globals.set("helperId", pm.info.requestId)` for later requests.

A request in another collection sees only its own collection's variables; the
caller's collection variables are not visible to it, so they cannot reach that
collection's hosts. Within the same collection the variables are shared.
Environment, iteration data, local variables and invocation overrides take
precedence over both. Invocation overrides cannot escape back into the caller.
Child global/environment/local changes return to the calling script; collection
changes remain with their owning collection. Referenced collection changes stay
available in memory even with persistence disabled. Server writes obey the run's
`persistVariables` setting. Await calls when ordering or variable changes matter.

A skipped reference returns `null`. Network failures reject after returning
partial variable changes. Child assertions and script errors appear in the root
results. References do not create separate history/run-result rows.

## Limits and distribution

The host enforces ten saved-request calls per script, five nested references and
100 referenced executions per root request. All host requests also count against
the script's host quota. Caller cancellation and script timeouts abort nested
HTTP. Timers and intervals share a bounded scheduling quota. Scripts have no Node
APIs, filesystem, `fetch`, or arbitrary host object references. Host limits still
apply if scripts replace their guest helpers.

`npm run build:sandbox` bundles the pinned browser libraries as JavaScript source
for execution inside QuickJS. The normal dev/test/typecheck/lint/build commands
regenerate this ignored artifact; the standalone CLI builder does the same.
Trusted library initialization has its own five-second guard and runs within the
script memory limit, before the user script's timeout starts. The production web
and CLI bundles include this source, so runtime installations need no bundler.

## Conformance

`tests/helpers/sandbox-conformance.ts` defines one deterministic contract used by
the actual Send route, collection runner and built standalone CLI. It checks SDK
URL/auth/body/header mutations reaching HTTP, callback tests, full Chai behavior,
schema drafts/references, SDK-based sends, saved-request responses, scope
precedence, locations and isolation. Focused tests cover malformed host messages,
quotas, nested collection ownership, persistence settings, cookie boundaries,
redaction, timeout cleanup, external cancellation, intervals and binary streams.

References: [sandbox API](https://learning.postman.com/docs/tests-and-scripts/write-scripts/postman-sandbox-reference/overview/),
[execution semantics](https://learning.postman.com/docs/tests-and-scripts/write-scripts/postman-sandbox-reference/pm-execution/),
[test APIs](https://learning.postman.com/docs/tests-and-scripts/write-scripts/postman-sandbox-reference/pm-test-expect/).
