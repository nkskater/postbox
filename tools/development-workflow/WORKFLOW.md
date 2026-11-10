# Shared development lifecycle

This is the canonical process for every contributor and coding environment. Read
`AGENTS.md`, `ARCHITECTURE.md` where present, and `.github/development-workflow.json`.
Configuration supplies Jira origin/project keys, repository, base, status names,
ownership label prefix, local commands and required check names. Resolve transition
IDs from each issue's available transitions; never copy IDs between projects.

## Claim and isolate

1. Refresh Jira: epic children **and the wider project**, dependencies, active claims,
   comments, file ownership and open PRs. Inspect shared checkout/worktrees before
   fetching current base. Never reset, remove or stage another story's work.
2. Select one eligible, unclaimed To Do story. Read acceptance criteria and scope.
   Jira owns execution identity: preserve labels, append the configured ownership
   label, transition In Progress, and add a claim comment with identity, unique
   session/claim reference, timestamp, branch, scope and intended files. Preserve a
   human assignee; unassigned is acceptable unless the project defines another
   convention. Never invent service accounts. Label updates replace arrays: read
   first, preserve all values, write, then reread.
3. Jira tools may not atomically claim. Reread status, labels and recent comments
   immediately before **and after** claiming. Stop development on conflicting
   claims; record the race in Jira and resolve with the existing claimant before
   proceeding. Earliest uncontested claim wins; a tie requires explicit handoff.
   This convention reduces races; it is not an atomic lock.
4. Use a dedicated worktree from current base, branch `ISSUE-123-short-description`.
   No execution identity in branch names or GitHub artifacts. Honor active and
   deferred file reservations. Coordinate shared files through Jira before editing.

## Develop and review

5. Implement acceptance criteria using the configured human Git author/committer.
   Every development commit subject is `[ISSUE-123] type: summary` (optional scope
   and `!` supported). Branch, PR title and commit keys agree exactly. Rebase onto
   main for updates; unkeyed branch-update merge commits fail policy. Never bulk
   rewrite historical main. Existing unfinished branches must adopt these rules
   for future commits and reword only their own unpublished commits when necessary.
6. Never put execution identity in commit metadata, trailers, PR descriptions,
   branches, source comments or repository documentation. No coauthor or generation
   credit. Product/API discussions may use product names normally. The checker
   inspects attribution patterns and metadata rather than banning product names
   throughout prose. Review changed content for attribution too; static pattern
   checks cannot infer every paraphrase or scan semantic authorship of source files.
7. Open a PR titled `[ISSUE-123] type: summary` with the exact story URL and
   `Validation:` evidence. Write the PR URL to that story, preserving earlier PR
   provenance. Comments/remote links are supplementary. Verify **native Jira
   Development records** on the exact story (PR and keyed commit/branch records).
   A URL in the PR body alone does not establish ingestion. See README for setup
   and diagnostics. Keep draft/unfinished work In Progress.
8. Run all configured local checks before In Review. Postbox requires `npm test`,
   `npm run typecheck`, `npm run lint` (zero errors), and `npm run build`.
   UI behavior also requires `npm run test:e2e` against the production build; a UI
   bug needs a browser regression that fails without the fix. Run the workflow
   tests when changing the package. Record actual results and limitations in Jira
   and the PR. Request review only after the quality gate passes.

## Merge, complete and clean up

9. Confirm current head, current base, all configured required CI checks, required
   reviews, and no unresolved findings. Inspect native Jira integration failures;
   do not merge through one as if comments proved linkage. Recheck PR metadata
   just before merging. Use `GH_TOKEN` from your existing authenticated environment
   with `node tools/development-workflow/merge.mjs PR_NUMBER [merge|squash|rebase]`.
   The command checks fresh policy, final-head CI, review state, unresolved threads,
   head lease and tested merge tree. It never uses admin bypass. The server's
   branch protection remains authoritative. Postbox's owner authorizes ready
   merges; other repositories must establish their own merge authorization.
10. For merge/squash, use the validated PR title as final subject and only the Jira
    URL as body. Repository defaults should match. Rebase preserves already checked
    commit subjects. Never add generation trailers during merge. GitHub can allow
    a human to override default messages; the helper and post-merge verification
    catch this, while defaults alone are not immutable message enforcement.
11. Verify merged SHA/tree equals the tested merge tree, the commit is an ancestor
    of current remote main, and native Development reflects the merged PR and
    keyed commits. Record PR URL, development/merge commit URLs and validation
    evidence in Jira. Transition Done **only after** these checks. On a genuine
    external integration restriction, record exactly what failed; keep completion
    pending until resolved. Do not fabricate integration evidence.
12. Retain claiming labels on Done as history; status and latest claim/handoff
    comment determine active ownership. For blocked/deferred work, record reason,
    reservation, branch/worktree and resumption criteria; use a configured blocked
    status if available, otherwise keep In Progress with explicit deferred claim.
    Do not silently select a second active story. User reprioritization permits an
    explicit context handoff before the next claim. Reassignment preserves earlier
    labels/comments and records the new active identity clearly.
13. Remove only this completed story's clean worktree, its branches and its own
    processes. Verify dirty/untracked files first. Never clean other worktrees just
    because their PRs merged. Refresh shared main only when it is clean.

## Exceptions

There is no blanket bot/dependency exemption: automation must obtain a real Jira
story and conform, or a separately reviewed, narrowly scoped policy change must
name the exact trusted app, metadata and permitted paths. The sole current
metadata exception is GitHub's web-flow committer with its exact name/email;
commit subject and attribution checks still apply. Historical main commits are
outside the PR-only validation set.

Split multi-story changes into separate PRs. If indivisible, document an approved
exception on **every** affected story before work; implement a reviewed explicit
key-set policy and test it before opening the PR. Current policy deliberately
rejects mixed keys instead of silently attributing to an arbitrary story/epic.
Additional links in explanatory prose do not change the primary story.
