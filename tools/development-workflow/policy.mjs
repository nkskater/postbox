import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const attribution =
  /(?:co-authored-by\s*:|generated[- ](?:with|by)\s*:?)|(?:\b(?:implemented|written|authored|created)\s+by\s+(?:an?\s+)?(?:codex|claude|antigravity|copilot|chatgpt)\b)|(?:\bagent\s*:\s*(?:codex|claude|antigravity)\b)/i;
const agentIdentity = /(?:\b(?:codex|claude|antigravity|copilot|chatgpt|anthropic|openai)\b|\[bot\])/i;
const conventional =
  "(?:feat|fix|perf|chore|docs|test|refactor|build|ci|style|revert)(?:\\([a-zA-Z0-9._/-]+\\))?!?: .+";
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function validateConfig(config) {
  if (
    !Array.isArray(config.projectKeys) ||
    !config.projectKeys.length ||
    config.projectKeys.some((key) => !/^[A-Z][A-Z0-9_]*$/.test(key))
  )
    throw new Error("Invalid projectKeys");
  const url = new URL(config.jiraUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/")
    throw new Error("jiraUrl must be an HTTPS origin");
  if (!/^[\w.-]+\/[\w.-]+$/.test(config.repository) || !config.baseBranch)
    throw new Error("Invalid repository/baseBranch");
}

export function validatePullRequest(config, pr, commits) {
  validateConfig(config);
  const errors = [];
  const issue = `(?:${config.projectKeys.map(escape).join("|")})-[1-9][0-9]*`;
  const match = new RegExp(`^(${issue})-[a-z0-9]+(?:-[a-z0-9]+)*$`).exec(pr.head.ref);
  const key = match?.[1];
  if (!key) errors.push("Branch must be ISSUE-123-short-description");
  if (pr.base.ref !== config.baseBranch) errors.push("Unexpected base branch");
  if (!new RegExp(`^\\[${escape(key ?? "INVALID")}\\] ${conventional}$`).test(pr.title))
    errors.push("PR title must be [ISSUE-123] type: summary and match branch");
  const body = pr.body ?? "";
  // URL boundaries prevent a link to ISSUE-1234 passing for ISSUE-123.
  if (
    !new RegExp(`${escape(config.jiraUrl)}/browse/${escape(key ?? "INVALID")}(?=$|[\\s)\\]>.,])`).test(body)
  )
    errors.push("PR body needs direct exact-story Jira URL");
  if (!/\bValidation\s*:/i.test(body) || !body.split(/\bValidation\s*:/i)[1]?.trim())
    errors.push("PR body needs Validation: evidence");
  if (attribution.test(`${pr.title}\n${body}`)) errors.push("PR contains attribution");
  if (agentIdentity.test(pr.head.ref)) errors.push("Branch contains attribution");
  if (!commits.length) errors.push("PR has no commits");
  for (const commit of commits) {
    const message = commit.commit.message;
    if (!new RegExp(`^\\[${escape(key ?? "INVALID")}\\] ${conventional}$`).test(message.split("\n")[0]))
      errors.push(
        `${commit.sha}: commit subject must match story and conventional format; rebase main updates`,
      );
    if (attribution.test(message)) errors.push(`${commit.sha}: commit contains attribution`);
    for (const role of ["author", "committer"]) {
      const person = commit.commit[role];
      // GitHub's web-flow committer is the sole integration identity exception.
      const webFlow =
        role === "committer" &&
        person?.name === "GitHub" &&
        person?.email === "noreply@github.com" &&
        commit.committer?.login === "web-flow";
      if (
        !webFlow &&
        agentIdentity.test(`${person?.name ?? ""} ${person?.email ?? ""} ${commit[role]?.login ?? ""}`)
      )
        errors.push(`${commit.sha}: ${role} contains attribution; use repository human identity`);
    }
  }
  return errors;
}

export async function github(path, { token = process.env.GH_TOKEN, method = "GET", body } = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`GitHub ${method} ${path}: ${response.status}`);
  return response.status === 204 ? null : response.json();
}

export async function readPullRequest(config, number, api = github) {
  if (!Number.isSafeInteger(number) || number < 1) throw new Error("Invalid PR number");
  const path = `/repos/${config.repository}/pulls/${number}`;
  const pr = await api(path);
  const commits = [];
  for (let page = 1; ; page++) {
    const batch = await api(`${path}/commits?per_page=100&page=${page}`);
    commits.push(...batch);
    if (batch.length < 100) break;
    if (page >= 250) throw new Error("Commit pagination limit exceeded");
  }
  if (commits.length !== pr.commits) throw new Error("Incomplete commit list or PR changed; rerun");
  const latest = await api(path);
  if (
    latest.head.sha !== pr.head.sha ||
    latest.base.sha !== pr.base.sha ||
    latest.title !== pr.title ||
    latest.body !== pr.body ||
    latest.head.ref !== pr.head.ref
  )
    throw new Error("PR changed while validating; rerun");
  return { pr, commits };
}

export async function check(config, number, expectedHead) {
  const { pr, commits } = await readPullRequest(config, number);
  if (expectedHead && pr.head.sha !== expectedHead)
    throw new Error("Event head is stale; rerun on latest head");
  const errors = validatePullRequest(config, pr, commits);
  if (errors.length) throw new Error(errors.join("\n"));
  return pr;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = JSON.parse(readFileSync(".github/development-workflow.json", "utf8"));
  const pr = await check(config, Number(process.argv[2]), process.env.EXPECTED_HEAD);
  console.log(`Workflow policy passed for PR #${pr.number} at ${pr.head.sha}`);
}
