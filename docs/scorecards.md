# API quality scorecards

Open **Catalog → Quality scorecards** in the app. A workspace scorecard combines
existing catalog metadata, retained monitor measurements and saved specification
governance reports. Evaluations never execute requests, scripts or governance
checks. Run those source checks in Monitors or Specifications first.

Create a policy, edit the JSON and **Save scorecard**. Subsequent saves append an
immutable version with an optional label. The version selector can inspect or
evaluate an older policy. Saving an older policy appends a new version; it does
not rewrite history. Concurrent policy and assignment saves require the current
revision and return 409 if another writer changed it.

## Weighted configuration

```json
{
  "formatVersion": 1,
  "name": "Service readiness",
  "thresholds": { "healthy": 90, "attention": 70 },
  "unavailable": "zero",
  "minimumCoverage": 100,
  "categories": [
    {
      "id": "runtime",
      "name": "Runtime",
      "weight": 3,
      "metrics": [
        {
          "id": "availability",
          "name": "Availability (%)",
          "measure": "availability",
          "weight": 3,
          "good": 100,
          "bad": 90,
          "maxAgeHours": 24
        },
        {
          "id": "latency",
          "name": "p95 latency (ms)",
          "measure": "latency",
          "weight": 1,
          "good": 200,
          "bad": 2000,
          "maxAgeHours": 24
        }
      ]
    },
    {
      "id": "specification",
      "name": "Specification",
      "weight": 1,
      "metrics": [
        {
          "id": "governance",
          "name": "Governance errors",
          "measure": "governanceErrors",
          "weight": 1,
          "good": 0,
          "bad": 10,
          "maxAgeHours": 24
        }
      ]
    }
  ]
}
```

Each metric scores `100 × (value − bad) / (good − bad)`, clamped to 0–100.
`good > bad` rewards increasing values; `good < bad` rewards decreasing values.
Targets must differ, and all weights are positive. Metric weights normalize
within their category, then category weights normalize across the policy.
Identifiers are stable lowercase letters/digits/hyphens, starting with a letter;
category IDs and metric IDs must each be unique.

A score at or above `healthy` is healthy; one at or above `attention` is attention;
a lower score is critical. Healthy must exceed attention. Classification uses
unrounded scores; display scores are rounded to two decimals. In the example,
100% availability, 2000 ms latency and 5 governance errors produce category
scores 75 and 50, and an overall score of 68.75 (critical with these thresholds).

Missing, nonfinite, future-dated, incomplete or stale observations do not receive
a successful score. Every metric includes its source identity/version, observed
time, allowed age, availability state and a reason. `maxAgeHours` defaults to 24.
Saved governance reports must also match the current source, binding and policy;
being recent alone does not make an obsolete report fresh. A governance report
with no evaluated targets cannot establish specification quality.

`unavailable: "zero"` includes missing metric weights as zero when computing a
partial score. `"exclude"` explicitly renormalizes over available measurements.
Coverage always reports the weighted fraction that has usable data, regardless
of this choice. Quality is **unknown** below `minimumCoverage` (default 100) or
when no measurements are available. An unavailable metric displays a null score,
not a fabricated zero observation. Entirely unavailable service slices count as
zero in a partially available portfolio unless exclusion is configured. A
portfolio with no usable measurements has a null score and unknown quality.
Service/environment slices carry equal weight in the portfolio summary.

## Measurements and service assignments

| Measure                                   | Source / unit                                                                                                            |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `availability`                            | Latest retained, non-skipped monitor sample; available requests as a percentage. No observed requests means unavailable. |
| `assertions`                              | Passing monitor assertions as a percentage; no assertions means unavailable.                                             |
| `latency`                                 | Monitor sample p95 latency in milliseconds; no timings means unavailable.                                                |
| `tests`                                   | Executed assertions in the latest sample. A recorded zero is a valid observation.                                        |
| `scriptErrors`                            | Recorded script errors in the latest monitor sample.                                                                     |
| `governanceErrors` / `governanceWarnings` | Counts from the latest complete, current saved governance report.                                                        |
| `governancePassRate`                      | Percentage of evaluated targets without diagnostics, clamped at zero; no targets means unavailable.                      |
| `description`                             | Current catalog description exists: 1, otherwise 0.                                                                      |
| `ownership`                               | Current catalog has named owners: 1, otherwise 0.                                                                        |
| `publishedAgeHours`                       | Age of the latest published catalog version in hours. Metadata-only edits do not reset publication time.                 |

Assign a published catalog service (a collection), an environment or **No
environment**, and optional existing specification/monitor sources. Each
service/environment pair has one assignment per scorecard. Use **Edit assignment**
to revise it or **Remove assignment** to remove it.

Sources must share the scorecard workspace. A monitor must additionally match
the service collection and selected environment. Changing its configuration to a
different collection/environment makes that source unavailable until reassigned.
Deleting an assigned environment leaves a visible deleted-environment assignment;
runtime/spec metrics become unavailable instead of silently falling back to a
different environment. Sources may remain unassigned: their absence is explicit
in the resulting report.

Tag and owner filters match exact catalog metadata values. Environment filtering
supports a particular environment, no environment, or all environments. Filters
combine with AND. No matches produce an empty report with unknown quality.

## History, comparison and export

**Preview quality** is read-only. **Run and save quality report** retains a snapshot
with policy version/hash, evaluation time, source provenance, measurements,
coverage and service scores. Export policy, report and comparison JSON using the
buttons in the app. These files contain quality metadata and measured numbers,
not request/response bodies, credentials or environment variable values.

Select a saved report to inspect its original measurements. These are historical
snapshots, not a claim about current source freshness. Compare two reports to
see score/coverage changes for matching service/environment pairs and additions
or removals. A changed policy is flagged. Metric comparison uses stable IDs and
flags changed measure, target, weight or freshness definitions as noncomparable.
Comparison exports include those metric details.

Workspace readers can preview, list and export reports; editors can change
policies/assignments and retain reports. Internal quality data requires workspace
access even if catalog documentation is public. Current catalog visibility is
rechecked for every historical read and comparison. Revoked, deleted, private or
otherwise inaccessible services are removed before returning service data or
computing portfolio summaries. Previously exported data is a local snapshot.

Limits: 50 scorecards per workspace, 100 policy versions, 10 categories/50 total
metrics and 64 KiB per policy, 200 service/environment assignments per scorecard,
50 retained reports per scorecard, and freshness limits up to 2160 hours. Policy
and report JSON count toward workspace storage quotas. Backups retain policies,
versions and assignments, and omit measurement history. Catalog publications
restore disabled under the existing catalog restore policy; republish and
reassign services before evaluating them again. Monitor samples and governance
history must be recreated by their source checks after restore.

## REST and MCP automation

All routes use normal workspace/token authorization, outside the v1 management
OpenAPI inventory. IDs below are opaque strings.

| Method         | Route                                    | Body / behavior                                                                                                                            |
| -------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| GET / POST     | `/api/scorecards`                        | List with `?workspaceId=...`; create `{workspaceId, config, label?}`.                                                                      |
| GET            | `/api/scorecards/ID?version=N`           | Policy/version history; latest when version is omitted.                                                                                    |
| PATCH / DELETE | `/api/scorecards/ID`                     | Append `{expectedRevision, config, label?}` / delete.                                                                                      |
| GET            | `/api/scorecards/ID/sources`             | Permitted catalog entries, environments, monitors, specifications and assignments.                                                         |
| PUT            | `/api/scorecards/ID/bindings`            | `{entryId, environmentId?, specificationId?, monitorId?, expectedRevision}`. Empty environment ID means no environment; new revision is 0. |
| DELETE         | `/api/scorecards/ID/bindings/BINDING_ID` | Remove assignment.                                                                                                                         |
| POST           | `/api/scorecards/ID/preview`             | `{version?, filters?}`; no persistence or network execution.                                                                               |
| GET / POST     | `/api/scorecards/ID/reports`             | List / save a snapshot using `{version?, filters?}`.                                                                                       |
| GET            | `/api/scorecards/ID/reports/REPORT_ID`   | Retained snapshot with current catalog ACLs enforced.                                                                                      |
| POST           | `/api/scorecards/ID/compare`             | `{beforeId, afterId, filters?}`.                                                                                                           |

Filters are `{tag?, owner?, environmentId?}`. GET report routes accept them as
query parameters, intersected with the saved snapshot's original service set.
Omit `environmentId` for all environments; send an empty string for no environment.

MCP tools are `list_scorecards`, `get_scorecard`, `create_scorecard`,
`save_scorecard`, `delete_scorecard`, `list_scorecard_sources`,
`bind_scorecard_service`, `remove_scorecard_service`, `preview_scorecard`,
`save_scorecard_report`, `list_scorecard_reports`, `get_scorecard_report` and
`compare_scorecard_reports`. They take `scorecardId`; updates use `patch`,
assignments use `binding`, evaluations use optional `check`, and comparisons use
`comparison`. Read-only MCP mode omits all mutation/persistence tools.
