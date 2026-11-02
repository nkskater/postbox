# API governance and CI checks

Open **Governance** in the sidebar to create a policy. The default policy checks
API descriptions, operation summaries and unique camelCase operation IDs,
kebab-case paths, encrypted server transports, effective OpenAPI authentication
and references to declared security schemes. Change severities in the rule list
or edit the complete declarative JSON. Import/export uses that same JSON format.

**Save rule set** creates version 1. **Save new rule version** appends an immutable
version with an optional label. Inspect an earlier version from the selector;
saving it creates a new latest version without rewriting history. Concurrent
saves require the current revision and return 409 if it changed. Unsaved edits
prompt before switching policies. **Try draft policy** evaluates unsaved rules
against a saved specification without retaining a report.

Open a document in **Specifications** to assign a policy. Assignments can follow
the latest policy or pin an immutable version. Optional per-spec severity overrides
and justified exclusions are merged with the versioned policy. Save the assignment
before checking it. If a later policy removes an overridden rule, the assignment
remains editable and reports that it must be revised or pinned to a compatible
version; it is not silently ignored.

**Preview governance** is read-only. **Run and save report** retains source/policy
versions, content hashes, binding revision and diagnostics. Readers can preview
and inspect reports; editors can save policies, assignments and reports. The
latest report is marked stale after source, followed policy, or assignment changes.
Pinning a policy prevents an unrelated later policy version from changing results.
Historical reports remain inspectable and exportable. Governance checks do not
execute API requests or scripts.

## Custom declarative rules

```json
{
  "formatVersion": 1,
  "name": "Team API policy",
  "rules": [
    {
      "id": "contact-email",
      "message": "Provide an API contact email",
      "severity": "error",
      "formats": ["openapi", "asyncapi"],
      "scope": "document",
      "given": "/info",
      "field": "/contact/email",
      "check": { "kind": "required" }
    },
    {
      "id": "operation-prefix",
      "message": "Use a verb prefix for operation IDs",
      "severity": "warning",
      "scope": "operations",
      "given": "/*",
      "field": "/operationId",
      "check": { "kind": "matches", "value": "get*" }
    }
  ],
  "overrides": { "operation-prefix": "info" },
  "exclusions": [
    {
      "ruleId": "contact-email",
      "file": "internal.yaml",
      "path": "/info/contact/email",
      "reason": "Internal-only fixture without a support address"
    }
  ]
}
```

Rule IDs are unique lowercase letters/digits/dots/hyphens, starting with a letter.
`syntax-` and `governance-` prefixes are reserved. Severities are `error`, `warning`,
`info` and `off`. Overrides and exclusions must refer to known rules (or `*` for
all rules in an exclusion). Exclusions always require a reason.

`given` selects existing nodes using `/`-prefixed JSON pointers with `*` for one
segment and `**` for descendants. Empty selects the scope root. Escape `~` as
`~0` and `/` in a key as `~1`. `field` selects an exact relative pointer beneath
each match, allowing checks of missing fields. For example, select `/info` and
check `/contact/email`; selecting a missing `/info/contact/email` directly has
no matches. `target: "key"` checks the selected key instead of its value and
cannot be combined with `field`.

| Scope        | Selected data                                                                                                    |
| ------------ | ---------------------------------------------------------------------------------------------------------------- |
| `document`   | Authored JSON/YAML document; `files` is `entrypoint` (default) or `all`                                          |
| `operations` | `/*` selects OpenAPI operations or AsyncAPI operations; OpenAPI security inherits from the root only when absent |
| `paths`      | `/*` selects OpenAPI path items, with the actual path available using `target: "key"`                            |
| `servers`    | `/*` selects declared root/path/operation servers, including Swagger schemes and AsyncAPI server protocols       |
| `symbols`    | `/*` selects the specification analyzer's types, fields/shapes/operations and descriptions                       |
| `references` | `/*` selects the analyzer's reference targets and resolution status                                              |

Document/operation/path/server scopes support OpenAPI and AsyncAPI; Smithy JSON
AST supports document checks. Symbol/reference scopes also support GraphQL,
protobuf and Smithy IDL. Set the rule's `formats` explicitly for these formats.
Defaults are OpenAPI and AsyncAPI. Unsupported scopes or unmatched selectors
are counted as not applicable, making coverage visible. Document checks inspect
authored nodes; operation references are followed through supplied bundle files
with source locations retained. There is no filesystem or network reference loading.

| Check                                | Additional fields / meaning                                                              |
| ------------------------------------ | ---------------------------------------------------------------------------------------- |
| `required`, `forbidden`, `nonEmpty`  | Presence, absence, or nonempty string/array/object                                       |
| `type`                               | `value`: string, number, boolean, object or array                                        |
| `casing`                             | `value`: camel, pascal, snake, kebab or lower                                            |
| `equals`, `notEquals`                | `value`: a JSON primitive                                                                |
| `oneOf`                              | `values`: permitted JSON primitives                                                      |
| `startsWith`, `endsWith`, `contains` | `value`: literal text                                                                    |
| `matches`                            | `value`: bounded `*`/`?` wildcard pattern; not a regular expression                      |
| `minLength`                          | `value`: minimum string/array length                                                     |
| `unique`                             | Unique selected values across the rule's matches                                         |
| `pathKebab`                          | Lowercase kebab-case literal path segments; `{parameter}` segments are allowed           |
| `https`                              | HTTPS/WSS URL or explicit encrypted AsyncAPI protocol                                    |
| `security`                           | Nonempty effective OpenAPI requirement alternatives; an empty optional alternative fails |
| `securityReferences`                 | Requirements reference declared schemes and have arrays of scope strings                 |

Rules do not evaluate JavaScript, arbitrary expressions, remote functions or
user-provided regular expressions. Syntax/reference diagnostics from the source
analyzer always remain errors/warnings independently of governance exclusions;
turning policies off cannot hide malformed source. This is a bounded governance
pass, complementing each specification format's full standards/compiler checks.

## CLI and CI

```bash
postbox governance defaults > governance-rules.json
postbox governance lint openapi.yaml --rules governance-rules.json --json
postbox governance lint openapi.yaml --include models/pet.yaml --fail-on warning --report governance-report.json
```

Input can be a raw definition or a specification workspace's exported JSON bundle.
Use `--format openapi|asyncapi|graphql|protobuf|smithy` when autodetection is
insufficient. Included files are supplied explicitly, must be under the root
file's directory and use relative bundle paths. No references are fetched.
`--include` and `--format` cannot override a bundle's declared files/format.

JSON reports are deterministic for the same source and policy, with no timestamps.
Diagnostics are sorted by file, line, column, rule and pointer; hashes identify
source and effective policy contents. The app uses the same engine and JSON
report structure. `--report` writes a JSON artifact; existing files are protected
unless `--overwrite` is explicit. Without `--json`, stdout is a located text report.
The existing global `--output` option retains its management-command meaning.

| Exit | Meaning                                                                                     |
| ---- | ------------------------------------------------------------------------------------------- |
| 0    | Complete result with no diagnostics at/above the failure threshold                          |
| 1    | Complete result with diagnostics at/above `--fail-on error` (default), `warning`, or `info` |
| 2    | Invalid CLI arguments                                                                       |
| 4    | Input/rule file not found or unreadable                                                     |
| 5    | Invalid rule/configuration/input format or unwritable report artifact                       |
| 6    | Resource limits prevented a complete evaluation                                             |

A syntax failure is a failed result (1), not a clean check. An incomplete result
never passes CI. Reports count checked, excluded, disabled and not-applicable
rules/targets explicitly. Governance messages describe the policy failure without
echoing evaluated field values; parser diagnostics may include syntax details.

## Limits and persistence

Existing specification limits apply: 30 supplied files, 1 MiB UTF-8 per file,
3 MiB total, depth 60 and bounded source parsing. Policies allow 100 rules,
200 combined exclusions, 128 KiB of configuration and 100 immutable versions.
There are at most 50 policies per workspace and 50 retained reports per
specification. Configuration/report storage counts toward workspace quotas.
Selectors/checks have 50,000 target and five-million work-unit budgets. Reports
contain at most 500 diagnostics plus an explicit limit diagnostic when incomplete.

Workspace backups retain rule sets, versions and assignments. Report history is
recomputed after restore, so restored assignments show no fresh retained result.
Invalid latest-version assignments remain editable after restore. Deleting a
rule set also removes its assignments and reports. Deleting a specification or
workspace cascades its governance data.

## REST and MCP

App-specific endpoints use normal workspace and API-token authorization, outside
the v1 management OpenAPI inventory.

| Method         | Path                                                  | Behavior                                                                                               |
| -------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| GET/POST       | `/api/governance/rulesets`                            | List by `workspaceId` / create `{workspaceId, config, label?}`                                         |
| GET            | `/api/governance/rulesets/ID?version=N`               | Policy configuration and immutable version list                                                        |
| PATCH/DELETE   | `/api/governance/rulesets/ID`                         | Save `{expectedRevision, config, label?}` / remove policy                                              |
| POST           | `/api/governance/lint`                                | Read-only draft `{workspaceId, source, config}` analysis                                               |
| GET/PUT/DELETE | `/api/specifications/ID/governance`                   | Inspect / save `{ruleSetId, ruleVersion, overrides, exclusions, expectedRevision}` / remove assignment |
| POST           | `/api/specifications/ID/governance/lint`              | Read-only assigned-policy check, optional `{version}`                                                  |
| GET/POST       | `/api/specifications/ID/governance/reports`           | List / evaluate and retain report, optional `{version}`                                                |
| GET            | `/api/specifications/ID/governance/reports/REPORT_ID` | Retained diagnostic report                                                                             |

Use `ruleVersion: null` to follow latest. New assignment `expectedRevision` is 0;
updates use the current revision. Report responses retain source and rule versions,
binding revision and core report; export the nested `report` for CLI equivalence.

MCP tools: `list_governance_rule_sets`, `get_governance_rule_set`,
`create_governance_rule_set`, `save_governance_rule_set`, `delete_governance_rule_set`,
`get_specification_governance`, `bind_specification_governance`,
`unbind_specification_governance`, `lint_governance_draft`,
`preview_specification_governance`, `save_governance_report`,
`list_governance_reports`, `get_governance_report`. IDs use `ruleSetId`,
`specificationId`, `reportId`; policy updates use `patch`. Read-only MCP mode
exposes inspection and preview, excluding policy/assignment/report mutations.

Reference: [Postman API governance](https://learning.postman.com/docs/api-governance/api-governance-overview/).
