# Project audit implementation

This branch starts the audit remediation. It is intended for review before any
merge to main. It does not make Postbox safe for untrusted network exposure.

## Implemented in the reliability and performance batch

- [x] M4: Preserve draft edits made while saving and prevent duplicate create saves.
- [x] M4: Ignore stale workspace, environment, variable, and request-load responses,
      including switching away from and back to the same workspace.
- [x] M4: Keep old request cancellation from changing a newer send's state; abort
      sends on tab closure or workspace changes.
- [x] M7: Group folders and requests once during tree construction instead of
      scanning workspace arrays for every folder; detect corrupt tree cycles.
- [x] M7: Add workspace/sort indexes for requests and environments through migration
      0002_query_indexes, with EXPLAIN QUERY PLAN regression checks.
- [x] L2: Release runner delay abort listeners when timers complete normally.
- [x] Extract and test a bounded NDJSON reader: fragmented UTF-8, CRLF, final events
      without newlines, early exit, malformed events, and reader cleanup.
- [x] Release progress streams when leaving the runner tab and report unexpected
      end-of-stream; server runs still continue and remain accessible in history.
- [x] Narrow runner store subscriptions to avoid unrelated state updates.
- [x] Escape JUnit error text without unsafe CDATA delimiters and exclude skipped
      assertions from per-suite failure counts.

Validation: all 82 tests pass; production compilation and typechecking pass.
ESLint reports only the two existing navigation warnings. UI lifecycle behavior
has unit coverage for state/stream logic, but no browser end-to-end run was performed.

## Runner resource bounds (separate follow-up branch)

Branch: perf/runner-resource-bounds, based on security/audit-hardening at 0c46f71.
This is separate from Antigravity's fix/review-security-and-bugs and feat/mcp-server.

- [x] M1: Web runs persist per-result events without retaining a duplicate complete
      results array. Summary counters are accumulated incrementally.
- [x] M1: Cap each progress subscriber's event queue at 1 MiB. Disconnect stalled
      subscribers while allowing the run to continue persisting results.
- [x] Publish the done event only after final persistence succeeds.
- [x] Remove parent cancellation listeners on success and failure; honor signals
      already aborted before starting a persisted run.
- [x] Preserve default full-summary behavior for existing core/service callers.

The optional retainResults flag is additive. MCP callers can keep using startRun
unchanged; setting retainResults: false returns counters and an empty results array,
with full results available via getRunSummary. No MCP endpoint, desktop code,
HTTP policy, sandbox, OAuth cache, cookie persistence, or request parameter logic
is changed in this follow-up.

Remaining M1 work: browser result virtualization/pagination, paginated history
retrieval and exports, database retention, and run admission limits. Per-request
response buffering and script host-call bounds are separate outstanding work.

Follow-up validation: 94 tests pass across 12 files; typechecking and production
build pass. Lint retains the same two existing navigation warnings. No browser
end-to-end or Docker validation was performed for this follow-up.

## Implemented in the first review batch

- [x] H1: Reject out-of-range literal IPv4/IPv6 destinations under IP allowlists.
- [x] H2: Do not resurrect explicit cookies after crossing redirect origins.
- [x] H2: Disable Digest challenge responses after crossing an origin boundary.
- [x] H3: Bound every decompression stage and propagate size-limit failures.
- [x] H3: Use asynchronous decompression to avoid synchronous event-loop blocking.
- [x] M6: Reject already-aborted HTTP operations, including cancellation during jar access.
- [x] Add local regression coverage for these boundaries and successful normal cases.

Encoded bodies still use the existing truncation behavior. Oversized decoded
bodies now fail with ERESPONSETOOLARGE. Bodies remain buffered; asynchronous
decompression is an immediate mitigation, not a streaming implementation.

## Remaining priorities

1. C1: Authentication enforcement, browser-origin protection, and safer default
   network exposure. POSTBOX_PASSWORD/POSTBOX_TOKEN do not enforce authentication.
2. H4/L1: Script host-call quotas, concurrency limits, cancellation, worker isolation,
   explicit handle ownership, and cleanup/soak tests.
3. H5: OAuth cache credential/workspace isolation, bounded expiry, and eviction.
4. H6: Full request/auth/body schemas, guest message validation, and input byte limits.
5. H1/H2: Validate host-policy configuration and define handling for custom auth
   headers and HTTPS downgrade redirects.
6. M1: Add run admission limits, database retention, and paginated/virtualized browser
   results; server progress queues and web-run duplicate retention are bounded above.
7. M2/M3: Persist cookie deltas and enforce workspace relationships transactionally.
8. M5: Improve draft persistence, upload storage, and credential handling. M4's main
   save/load/send races are addressed above; browser end-to-end coverage remains.
9. M6: Surface truncation, preserve appropriate repeated headers, define redirect
   method semantics, and implement bounded streaming/download paths.
10. M7: Further optimize subtree payload loading and nextSort scans; tree grouping
    and workspace query indexes are implemented above.
11. M8: Quote generated cURL methods and protect PowerShell body delimiters.
12. L3-L6: Establish secret retention rules, constrain preview
    resources, sanitize unexpected API errors, and harden container resources.
13. Maintainability: Extract large UI components, narrow store subscriptions,
    escape JUnit CDATA, fix navigation lint warnings, and align documentation.

## Review focus

- Hostnames with IP allow rules still defer until DNS resolution, while literal
  addresses are checked immediately. Deny rules retain precedence.
- Same-origin cookies and Digest behavior remain supported. Once an origin boundary
  is crossed, this request chain cannot reuse Digest credentials.
- gzip, wrapped/raw deflate, Brotli, and stacked encodings enforce decoded limits.
  Optional Zstandard support uses Node's asynchronous decoder when available.
- Malformed compression retains the existing raw-payload fallback. Limit errors
  must never fall through to that fallback.
- Arbitrary custom authentication headers are not stripped by this batch.

Run npm test, npm run typecheck, npm run lint, and npm run build before review.
