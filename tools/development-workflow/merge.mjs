import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { check, github } from "./policy.mjs";

const config = JSON.parse(readFileSync(".github/development-workflow.json", "utf8"));
const number = Number(process.argv[2]);
const strategy = process.argv[3] ?? "merge";
if (!["merge", "squash", "rebase"].includes(strategy)) throw new Error("Use merge, squash or rebase");
const pr = await check(config, number);
if (pr.draft || pr.state !== "open") throw new Error("PR must be open and ready");
const gh = (...args) => execFileSync("gh", args, { encoding: "utf8" });
const state = JSON.parse(
  gh(
    "pr",
    "view",
    String(number),
    "--repo",
    config.repository,
    "--json",
    "headRefOid,reviewDecision,mergeStateStatus",
  ),
);
if (
  state.headRefOid !== pr.head.sha ||
  state.mergeStateStatus !== "CLEAN" ||
  ["CHANGES_REQUESTED", "REVIEW_REQUIRED"].includes(state.reviewDecision)
)
  throw new Error("Head, checks or reviews not ready");
const checks = JSON.parse(
  gh("pr", "checks", String(number), "--repo", config.repository, "--json", "name,state"),
);
for (const name of config.requiredChecks)
  if (!checks.some((c) => c.name === name && c.state === "SUCCESS"))
    throw new Error(`Required check not successful: ${name}`);
if (checks.some((c) => ["FAILURE", "ERROR", "PENDING", "QUEUED", "IN_PROGRESS"].includes(c.state)))
  throw new Error("Unresolved CI checks");
const threads = JSON.parse(
  gh(
    "api",
    "graphql",
    "-f",
    "query=query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100){nodes{isResolved} pageInfo{hasNextPage}}}}}",
    "-f",
    `owner=${config.repository.split("/")[0]}`,
    "-f",
    `repo=${config.repository.split("/")[1]}`,
    "-F",
    `number=${number}`,
  ),
).data.repository.pullRequest.reviewThreads;
if (threads.pageInfo.hasNextPage || threads.nodes.some((t) => !t.isResolved))
  throw new Error("Unresolved findings or review pagination; inspect before merging");
// Native Jira Development evidence must also be checked on the exact story by the
// operator before this command. No credentials are copied into this tool.
const latest = await check(config, number, pr.head.sha);
const base = await github(`/repos/${config.repository}/branches/${encodeURIComponent(config.baseBranch)}`);
if (base.commit.sha !== latest.base.sha) throw new Error("Base changed; refresh CI");
if (!latest.merge_commit_sha) throw new Error("Test merge unavailable");
const tested = await github(`/repos/${config.repository}/commits/${latest.merge_commit_sha}`);
const args = [
  "pr",
  "merge",
  String(number),
  "--repo",
  config.repository,
  `--${strategy}`,
  "--match-head-commit",
  pr.head.sha,
];
if (strategy !== "rebase")
  args.push(
    "--subject",
    latest.title,
    "--body",
    `Jira: ${config.jiraUrl}/browse/${pr.head.ref.match(/^[A-Z][A-Z0-9_]*-[0-9]+/)[0]}`,
  );
gh(...args);
const merged = await github(`/repos/${config.repository}/pulls/${number}`);
if (!merged.merged) throw new Error("Merge not confirmed");
const artifact = await github(`/repos/${config.repository}/commits/${merged.merge_commit_sha}`);
if (artifact.commit.tree.sha !== tested.commit.tree.sha)
  throw new Error("Merged tree differs from tested merge tree");
if (!artifact.commit.message.startsWith(`[${pr.head.ref.match(/^[A-Z][A-Z0-9_]*-[0-9]+/)[0]}] `))
  throw new Error("Final merge subject lost story key");
console.log(
  `Merged PR #${number}: ${merged.merge_commit_sha}. Verify tree against tested merge, main ancestry, Jira Development, then complete story and clean up.`,
);
