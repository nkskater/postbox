# Validate application-test traffic

`postbox app-test` evaluates collection post-response assertions against responses
already observed by a browser or UI test. It never sends collection requests,
runs pre-request scripts, follows redirects, or allows `pm.sendRequest` /
`pm.execution.runRequest`. Even a caught network attempt fails that observation.

Use full embedded Playwright HAR 1.2 recordings or Postbox observation JSON:

```sh
postbox app-test collection.json --capture test-results/network.har
postbox app-test collection.json --capture network.har --environment staging.json --strict-coverage
postbox app-test collection.json --capture network.har --target https://staging.example.com --filter 'Pets'
postbox app-test collection.json --capture network.har --format junit --report-file reports/application.xml
postbox app-test collection.json --capture network.har --format html --report-file reports/application.html
```

Multiple collection files are accepted. Matching uses the HTTP method, origin,
path, configured query values, and configured request body. Extra query keys are
allowed; configured repeated query values must match in order. Raw JSON bodies
match structurally (key order is irrelevant, extra object keys are not allowed).
Text bodies match exactly; URL-encoded bodies match configured enabled fields.
Multipart, binary and GraphQL body modes are unmatched; capture a text/JSON
request definition for these. Headers and auth are not match criteria.

Collection and environment variables resolve before matching. Unresolved whole
path segments such as `{{id}}` or `:id` bind the observed value, as do whole
query/body template values. Repeated variables must agree. Embedded unresolved
variables do not match. `--target` replaces the origin, including an unresolved
leading `{{baseUrl}}`; it must be an HTTP(S) origin without a path. Environment
values still control query/body expectations. The most specific path wins;
equally specific matching operations are reported as ambiguous, never guessed.
`--filter` selects operations by a literal collection/name/URL substring;
observations outside that selection remain unmatched.

Collection, folder and request test scripts run in that order with the captured
`pm.request`, `pm.response`, environment, collection variables and bound path
values. Mutations are local to the observation; project/environment files are
never updated. Tests must use the captured response; request execution and
pre-request side effects are unavailable. Imported request contracts are not a
replacement for `pm.test` assertions in this flow. Missing response bodies are
reported as incomplete rather than treated as passing assertions.

The JSON, JUnit and standalone HTML reports distinguish passing assertions,
failed assertions/script errors, unmatched calls, ambiguous matches, missing
responses, matched calls without assertions, and unexercised operations. Default
success requires at least one passing observation and no failures, ambiguous
matches or missing responses. `--strict-coverage` additionally fails on unmatched
calls, missing assertions or unexercised operations. JUnit marks coverage gaps as
skipped and emits a policy failure when they cause the overall run to fail.

## Explicit setup and UI-test commands

```sh
postbox app-test setup --write-config postbox-app-test.json --collection collection.json --capture-path test-results/network.har
postbox app-test --config postbox-app-test.json
```

Setup creates only the named config. Paths inside it are relative to that config;
explicit CLI paths are relative to the working directory. Configs are never
auto-loaded and cannot contain commands. Existing files are protected. Legacy
`app-init` is deprecated and directs you to `app-test setup`.

Configure Playwright explicitly in your own test runner, for example:

```ts
const context = await browser.newContext({
  recordHar: {
    path: process.env.POSTBOX_CAPTURE ?? 'test-results/network.har',
    mode: 'full',
    content: 'embed',
    urlFilter: '**/api/**',
  },
});
// Run your UI tests with this context. Always close it to flush the HAR.
await context.close();
```

No runner configuration, package scripts or agent files are silently patched.
Existing trace ZIPs and HARs with externally attached bodies must first be
exported as a full embedded HAR. Binary/non-UTF-8 bodies are unsupported.

To opt into executing your test runner, supply executable/arguments as a JSON
array. No shell parsing occurs. `POSTBOX_CAPTURE` points to a fresh private
`.har` file; your runner must write and flush that file. On Windows use an actual
executable such as `node` with the runner's JS entry point, rather than a `.cmd`
shell wrapper.

```sh
postbox app-test collection.json --capture reports/observations.json --command '["node","node_modules/@playwright/test/cli.js","test"]' --command-timeout 120000
```

The capture destination must not exist. Raw command output is not retained.
After reading the transient capture, Postbox writes redacted observation JSON to
`--capture` and removes the private temporary recording, including on failure.
Assertions use the original in-memory values before redaction. A nonzero command
exit fails the overall result even if all observed assertions pass. Ordinary
`--capture` mode never runs a command and leaves the supplied artifact untouched.
Keep source recordings private: only outputs Postbox creates are sanitized.

## Capture-only drafts and limits

```sh
postbox app-test --capture network.har --capture-only --draft review/pets.postman_collection.json
```

Drafts reuse the HAR importer, omit credentials/scripts, and include sanitized
response examples. They are reviewable collection files, never automatically
imported or executed. Capture-only success means a draft was created, not that
any tests passed. `--draft` can also accompany validation.

Native observation format:

```json
{
  "version": 1,
  "entries": [{
    "request": {"method": "GET", "url": "https://example.com/api/pets/7", "headers": []},
    "response": {"status": 200, "statusText": "OK", "headers": [{"name": "Content-Type", "value": "application/json"}], "body": "{\"id\":7}", "timeMs": 12}
  }]
}
```

Inputs are limited to 10 MiB each, 1,000 observations, 1,000 selected operations
and 20 collection files; individual bodies are limited to 1 MiB. Evaluation has a
30-second budget, 500 ms per script, 32 MiB per sandbox, 1,000 assertions per
observation and 10,000 assertions overall. Commands time out after 60 seconds by
default (configurable up to 10 minutes). File outputs are capped at 16 MiB and
never overwrite existing files. Named secret query/header/body fields, auth and
secret variable values are redacted before reports/drafts/recordings are saved;
unlabelled sensitive data may still need your own retention policy.

Exit codes: `0` passes (or capture-only draft created), `1` assertion/coverage or
UI-command failure, `2` usage error, `4` missing/unreadable input, `5` invalid
artifact/config or existing output, `6` output limit exceeded. A timed-out command
without a readable capture is an input error; no stale capture is reused.
