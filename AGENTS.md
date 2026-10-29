# Agent guide

Postbox is worked on by several coding agents (Claude, Codex, Antigravity). Jira is the single source of truth.

- **Jira project:** `LAB` (https://nkskater.atlassian.net/jira/software/projects/LAB)
- **Epic:** [LAB-25 — Postbox multi-agent board](https://nkskater.atlassian.net/browse/LAB-25)

## Workflow (mandatory)

1. **Check Jira first.** Open LAB-25 and read its child stories before touching code.
2. **Claim exactly one `To Do` story.** Move it to `In Progress`, add the label `agent:claude`, `agent:codex` or
   `agent:antigravity`, and comment the branch name you will use.
3. **One dedicated branch per story:** `<issue-key>-<slug>` (e.g. `LAB-32-cli-runner`), branched from the latest `main`.
4. **Stay in scope.** Each story lists the files/modules it owns. Never modify files owned by another agent's
   `In Progress` story; if you must, coordinate via a Jira comment and rebase after their merge.
5. **Open a PR** titled `[<issue-key>] <conventional summary>` and link the PR URL on the ticket. Move the story to
   `In Review` once these pass:
   ```bash
   npm test && npm run typecheck && npm run lint && npm run build
   ```
6. **`Done`** only after the PR is merged into `main`. New work you discover becomes a new `To Do` story under LAB-25.

## Repository rules

- Commits use the repo's configured git identity (`nkskater`). No `Co-Authored-By`/"Generated with" trailers and no
  mention of AI in commits, code comments, README or docs.
- Small conventional commits: `feat:`, `fix:`, `perf:`, `chore:`, `docs:`, `test:`.
- Do not commit `CLAUDE.md`, `.claude/`, scratch/worklog files or local databases.
- Architecture and layering rules: `ARCHITECTURE.md` (core engine in `src/core` must not import Next.js or the DB).
- Schema changes: edit `src/server/db/schema.ts`, then `npm run db:generate`; never edit applied migrations.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
