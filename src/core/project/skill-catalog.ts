/**
 * Task-specific agent skills shipped with the CLI. Each skill has its own
 * version; bump it whenever its files change so `postbox skills update` and
 * `postbox doctor` can tell installed copies are outdated.
 */
export interface SkillSource {
  name: string;
  version: string;
  description: string;
  /** SKILL.md body; the front matter is generated from the fields above. */
  body: string;
}

export const SKILL_SOURCES: SkillSource[] = [
  {
    name: "postbox-project",
    version: "1.0.0",
    description:
      "Set up and check a Postbox API test project: postbox init, postbox doctor and discovering CLI commands with postbox describe.",
    body: `# Postbox project setup

Use this when a repository needs API tests run by Postbox, or when a Postbox project looks broken.

## Create a project

\`\`\`sh
postbox init [dir] --name "Orders API" --base-url http://localhost:8080
postbox init --dry-run        # list what would be written
\`\`\`

\`init\` writes only files that do not exist yet and reports each one as \`created\` or \`kept\`; it never
overwrites a file. The layout:

- \`postbox.json\`: project config (\`collections\`, \`environment\`, optional \`data\`, \`reports\`, \`skills\`)
- \`collections/*.postman_collection.json\`: Postman v2.1 collections with tests
- \`environments/local.postman_environment.json\`: variables such as \`baseUrl\`
- \`.gitignore\`: ignores \`reports/\`

## Check a project

\`\`\`sh
postbox doctor [dir]          # alias: postbox status
postbox doctor --json
\`\`\`

Each check is \`ok\`, \`warn\` or \`fail\`. The exit code is 0 unless a check fails (then 5). Fix failures in the
order printed: an invalid \`postbox.json\` hides the checks that depend on it.

## Discover commands

\`postbox describe\` prints every command, argument and option as JSON, plus the exit codes.
\`postbox describe collection pull\` narrows it to one command. Prefer it to parsing \`--help\` text.
`,
  },
  {
    name: "postbox-collection-runs",
    version: "1.0.0",
    description:
      "Run Postman collections with the Postbox CLI locally or in CI, with environments, data files, reports and exit codes.",
    body: `# Running collections with Postbox

\`\`\`sh
postbox run collections/orders.postman_collection.json \\
  -e environments/local.postman_environment.json \\
  --reporters cli,junit --reporter-junit-export reports/results.xml
\`\`\`

- \`-e\` environment, \`-g\` globals, \`-d\` iteration data (CSV, JSON or XLSX; iterations default to its row count).
- \`--bail\` stops at the first failure; \`--timeout <ms>\` limits each request; \`--delay <ms>\` spaces them out.
- \`-H "Name: value"\` adds a default header to every request (repeatable).
- Reporters: \`cli\`, \`json\`, \`junit\`, \`html\`. Exports default to \`postbox-report.{json,xml,html}\`.
- Secret variable values are redacted from console output and reports.

## Exit codes

\`0\` all passed, \`1\` a request or assertion failed, \`130\`/\`143\` interrupted. Treat any other code as a
setup problem (bad file, bad option), not a test failure.

## Network limits

Requests obey \`PROXY_ALLOW_HOSTS\` and \`PROXY_DENY_HOSTS\` (comma lists of hosts, \`*.wildcards\` or CIDRs).
Unix sockets need \`--allow-socket <path>\`.

## In CI

Run \`postbox doctor\` first so a broken project fails with a clear message, then \`postbox run\` for each
collection listed in \`postbox.json\`, and publish the JUnit file.
`,
  },
  {
    name: "postbox-repository-files",
    version: "1.0.0",
    description:
      "Keep Postbox collections, environments and specifications in Git as files: pull, edit, push and resolve conflicts.",
    body: `# Postbox collections as repository files

\`\`\`sh
postbox collection pull <collectionId> --dir ./api     # writes files and .postbox-repo.json
postbox collection push --dir ./api --dry-run          # show the plan
postbox collection push --dir ./api [--prune]          # apply edited files
postbox collection import-dir ./api -w <workspace>     # create a new collection from files
\`\`\`

Environments and specifications work the same with \`postbox env pull|push\` and \`postbox spec pull|push\`.

## Editing the files

- One \`<slug>--<id>.request.json\` per request; folders are directories with \`folder.json\`.
- Scripts are separate \`.pre-request.js\` / \`.test.js\` files.
- \`order\` in \`collection.json\` / \`folder.json\` lists child ids in display order.
- New requests can omit \`id\`; run \`pull\` after pushing so they get one.
- Secret values are blank in the files. Never fill them in: a push never overwrites stored secrets.

## Conflicts

A push is refused (exit 5) when the collection changed in Postbox since the pull. Pull again, merge with Git,
then push. Use \`--force\` only when you mean to discard the server's changes.

\`postbox git connect|status|commit|branch|push|pull -d <dir>\` drives Git for the directory if needed.
`,
  },
  {
    name: "postbox-server-management",
    version: "1.0.0",
    description:
      "Manage a Postbox server from the command line: profiles, workspaces, collections, requests, environments and imports.",
    body: `# Managing a Postbox server

## Connect

\`\`\`sh
postbox profile add dev https://postbox.example.com --token-env POSTBOX_DEV_TOKEN --default
\`\`\`

Settings resolve from \`--url\` / \`--token\` / \`--profile\`, then \`POSTBOX_URL\`, \`POSTBOX_TOKEN\`,
\`POSTBOX_PROFILE\`, then the current profile. Prefer \`--token-env\` so no token is written to disk or shown in
the process list.

## Commands

Groups: \`workspace\`, \`collection\`, \`folder\`, \`request\`, \`example\`, \`env\`, \`globals\`, \`mock\`, and
\`import <file>\`. Run \`postbox describe <group>\` for the exact arguments.

- Pass \`-w <workspace>\` or set \`POSTBOX_WORKSPACE\` unless the account has one workspace.
- \`-o json\` gives stable output (also the default when piped). Lists return
  \`{"items", "total", "offset", "limit"}\` and take \`--limit\` / \`--offset\`.
- Deletes need \`--yes\` when not run in a terminal.

## Exit codes

\`2\` usage, \`3\` authentication or permission, \`4\` not found, \`5\` invalid input or conflict, \`6\` rate
limited, \`7\` server error, \`8\` network error. Retry only \`6\`, \`7\` and \`8\`.
`,
  },
];
