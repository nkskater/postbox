# Agent guide

Postbox is worked on by several coding agents (Claude, Codex, Antigravity). Jira is the single source of truth.

- **Jira project:** `LAB` (https://nkskater.atlassian.net/jira/software/projects/LAB)
- **Epic:** [LAB-25 — Postbox multi-agent board](https://nkskater.atlassian.net/browse/LAB-25)

## Workflow (mandatory)

Read [the shared lifecycle](tools/development-workflow/WORKFLOW.md) and
[repository configuration](.github/development-workflow.json) before starting.
That document is the canonical story-to-merge process for every contributor.
Run `node tools/development-workflow/setup.mjs` on each new checkout to add
local instruction pointers for other environments. If an environment does not
load a pointer automatically, configure its startup instructions to read AGENTS.md.

## Repository rules

- Commits use the repo's configured git identity (`nkskater`). No `Co-Authored-By`/"Generated with" trailers and no
  mention of AI in commits, code comments, README or docs.
- Development commits: `[LAB-123] type: summary`, with the same story key as branch and PR.
- Do not commit `CLAUDE.md`, `.claude/`, scratch/worklog files or local databases.
- Architecture and layering rules: `ARCHITECTURE.md` (core engine in `src/core` must not import Next.js or the DB).
- Schema changes: edit `src/server/db/schema.ts`, then `npm run db:generate`; never edit applied migrations.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
