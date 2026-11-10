# Install and operate the development workflow

Public reusable reference: [jira-github-agent-flow](https://github.com/nkskater/jira-github-agent-flow).
This repository keeps its application-specific configuration and integration evidence here.

This package uses Node 22 and standard GitHub read APIs. It has no npm dependencies
and no embedded credentials or local account IDs. `WORKFLOW.md` is the canonical
lifecycle; `AGENTS.md` is the common entry point. Configuration is at
`.github/development-workflow.json`.

## Adopt in another repository

1. Copy `tools/development-workflow/`, `.github/workflows/development-policy.yml`
   and the PR template. Merge the common entry-point pointer into its AGENTS.md;
   retain its product rules. Add local pointer directories to its ignore rules.
2. Create `.github/development-workflow.json` from the Postbox example, changing
   `projectKeys`, `jiraUrl`, `repository`, `baseBranch`, `statuses`, label prefix,
   local commands and required check names. Change the workflow's branch filter
   and template URL too. Do not copy cloud IDs, transition IDs or personal identity.
3. Run `node tools/development-workflow/setup.mjs` in each checkout/worktree. It
   appends pointers without replacing existing instructions and rejects symlinks.
   Local entry files are ignored, including the repository's forbidden instruction
   files. For environments that do not auto-load those filenames, set workspace
   startup instructions to read AGENTS.md and WORKFLOW.md explicitly. Verify each
   supported environment can state the commit/claim/review rules before using it.
   Never assume a tool auto-discovers an arbitrary filename.
4. Run `node --test tools/development-workflow/*.test.mjs`. The independent fixture
   uses DEMO-42, sample/service, a different Jira origin and trunk; it tests policy,
   pagination, stale metadata, attribution and additive/idempotent local setup.
5. Bootstrap through a reviewed PR. The new policy workflow runs on pull requests
   including metadata edits, pushes, reopen and readiness events; no path filter
   skips the required check. It uses a read-only token, never executes PR/branch
   text as shell code, and needs no Jira credentials. Fork workflows may need a
   maintainer's normal GitHub approval. CI can test untrusted code; do not give it
   secrets or write permissions. Never switch this checkout to pull_request_target.
6. After observing a successful `Workflow policy` run, configure base protection to
   require all configured check names, strict up-to-date checks, PRs, conversation
   resolution, no force push/deletion and administrator enforcement. Bind checks
   to the GitHub Actions app. Preserve existing required reviews; do not impose a
   new reviewer requirement without arranging an eligible reviewer. Inspect settings
   read-back and a real PR; declaring check names in JSON does not enforce them.
7. Set merge/squash default title to `PR_TITLE`, body to `BLANK`; keep rebase only
   when all development commits are validated. Use the merge helper for deliberate
   final messages and a head lease. Verify final artifact/tree and main ancestry.

A writer with permission to edit workflows can weaken repository-owned CI. Protect
changes to this package/workflows/config through normal review; organizations that
need protection against malicious repository administrators should use centrally
managed required workflows/rulesets with separate ownership. This package provides
repository-level guardrails, not an organization security boundary. Metadata edits
rerun policy on the same head; the merge helper revalidates live metadata to close
that stale-check window. GitHub merge queue is not enabled here; add merge_group
coverage to **all** required workflows before adopting a queue.

## Native Jira Development integration

[Atlassian's connection guide](https://support.atlassian.com/jira-cloud-administration/docs/integrate-with-github/)
and [linkage guide](https://support.atlassian.com/jira-cloud-administration/docs/use-the-github-for-jira-app/)
require issue keys in branch names, commit messages or PR titles. The package
requires all three, plus a direct story URL for readers. The integration, not PR
comments or Jira remote links, supplies native development records.

An administrator should open Jira Settings → Apps → GitHub for Atlassian, inspect
the connected GitHub account/organization and selected repository, synchronization
health and backfill. On GitHub inspect the installed app's selected repositories
and permissions. Confirm the Jira project grants View development tools to the
intended viewers. Do not install or expand account access blindly. For a new
installation, obtain the owner's approval for the exact app/repository/permissions.

On a real story, inspect Development for its branch, keyed commits and PR, including
GitHub URLs and current state. Available Jira REST/MCP reads can also expose the
native Development custom field (discover its field ID per site). Distinguish a
cached summary from a detailed live panel. Record the provider, counts/state and
verification time; do not count a comment as evidence. If absent, check exact keys,
repository selection, project/viewer permissions, ingestion errors/delay and then
request an admin resync. A tool unable to read installation settings cannot prove
which other repositories/projects are covered.

Postbox inspection found native GitHub provider
`oAuth-com.github.integration.production` on LAB-25 (two merged PRs) and LAB-211
(one merged PR), while LAB-91 had no records and no pushed commit/PR. Recent PR
branches/titles contain story keys but their development subjects often do not.
This demonstrates story-level PR ingestion and a commit-naming gap, not proof of
all installation settings. The authenticated GitHub token cannot enumerate user
app installations (403); repository installation lookup returns 404, and webhook
listing is empty (apps need not use repository hooks). Connected Jira tools expose
issue/claim/comment/transition operations and native field reads, but discovery
exposes no development-integration administration operation. No app installation
or account scope has been changed by this package.

## Routine checks and maintenance

- Run the policy locally with `GH_TOKEN` from an existing authenticated shell:
  `node tools/development-workflow/policy.mjs PR_NUMBER`. Do not print/store tokens.
- Required quality check names must match GitHub exactly. Inspect branch protection
  after renaming jobs and stage changes to avoid requiring a check that never runs.
- Update the single lifecycle/config, then test a real PR and the independent
  fixture. Agent entry points are pointers and need no lifecycle copies.
- Check native Development again after merge. Keep evidence and execution identity
  in Jira. Retain old PR/commit relationships when follow-up PRs are necessary.
- See [GitHub protection behavior](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)
  and [repository merge defaults](https://docs.github.com/en/rest/repos/repos#update-a-repository).

## Instruction discovery

The shared `AGENTS.md` covers environments that discover it natively.
Local setup adds `CLAUDE.md` and `.claude/CLAUDE.md` pointers for environments
using those entry points, and `.agents/rules/development-workflow.md` with
`trigger: always_on` for workspace rules. Check loaded instructions in the actual
client after setup; local rules are guidance, while CI supplies the merge gate.
See [Claude instruction discovery](https://code.claude.com/docs/en/memory) and
[Antigravity workspace rules](https://antigravity.google/docs/rules/).
