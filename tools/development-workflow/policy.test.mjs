import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validatePullRequest, readPullRequest, validateConfig } from "./policy.mjs";
import { setup } from "./setup.mjs";

const config = {
  projectKeys: ["DEMO"],
  jiraUrl: "https://example.atlassian.net",
  repository: "sample/service",
  baseBranch: "trunk",
};
const fixture = () => ({
  pr: {
    number: 7,
    commits: 1,
    head: { ref: "DEMO-42-add-validation", sha: "abc" },
    base: { ref: "trunk", sha: "def" },
    title: "[DEMO-42] feat: add validation",
    body: "Jira: https://example.atlassian.net/browse/DEMO-42\n\nValidation: node --test passed",
  },
  commits: [
    {
      sha: "abc",
      commit: {
        message: "[DEMO-42] feat: add validation",
        author: { name: "Developer", email: "dev@example.com" },
        committer: { name: "Developer", email: "dev@example.com" },
      },
    },
  ],
});
function rejected(change) {
  const f = fixture();
  change(f);
  assert.ok(validatePullRequest(config, f.pr, f.commits).length);
}
test("independent project configuration passes", () => {
  const f = fixture();
  assert.deepEqual(validatePullRequest(config, f.pr, f.commits), []);
});
test("rejects missing and mismatching branch/title/commit keys", () => {
  for (const change of [
    (f) => (f.pr.head.ref = "feature"),
    (f) => (f.pr.title = "[DEMO-43] feat: other"),
    (f) => (f.commits[0].commit.message = "feat: missing"),
    (f) => (f.commits[0].commit.message = "[DEMO-43] fix: other"),
    (f) => (f.pr.head.ref = "DEMO-42-bad_$(id)"),
    (f) => (f.pr.base.ref = "main"),
  ])
    rejected(change);
});
test("exact Jira URL and useful validation evidence required", () => {
  for (const body of [
    "https://example.atlassian.net/browse/DEMO-420\nValidation: pass",
    "https://evil.example/browse/DEMO-42\nValidation: pass",
    "https://example.atlassian.net/browse/DEMO-42",
    "https://example.atlassian.net/browse/DEMO-42\nValidation: ",
  ])
    rejected((f) => (f.pr.body = body));
});
test("blocks attribution variants and metadata, allows legitimate product discussion", () => {
  for (const suffix of [
    "\nCo-Authored-By: Someone <dev@example.com>",
    "\nGenerated with a tool",
    "\nwritten by Claude",
    "\nagent:codex",
  ]) {
    rejected((f) => (f.pr.body += suffix));
    rejected((f) => (f.commits[0].commit.message += suffix));
  }
  rejected((f) => (f.commits[0].commit.author.name = "Claude"));
  rejected((f) => (f.commits[0].commit.committer.email = "codex@openai.com"));
  rejected((f) => (f.commits[0].author = { login: "copilot[bot]" }));
  rejected((f) => (f.pr.head.ref = "DEMO-42-codex-work"));
  const f = fixture();
  f.pr.body += "\nAdds Claude API and OpenAI request support.";
  f.commits[0].commit.message = "[DEMO-42] feat: add Claude API and OpenAI support";
  f.commits[0].commit.committer = { name: "GitHub", email: "noreply@github.com" };
  f.commits[0].committer = { login: "web-flow" };
  assert.deepEqual(validatePullRequest(config, f.pr, f.commits), []);
});
test("all development commits checked for merge, squash and rebase paths", () => {
  const f = fixture();
  // All supported strategies preserve keyed development subjects; GitHub merge/squash
  // defaults and the merge command use the validated PR title as final subject.
  for (const strategy of ["merge", "squash", "rebase"]) {
    assert.deepEqual(validatePullRequest(config, f.pr, f.commits), [], strategy);
    assert.match(f.pr.title, /^\[DEMO-42\] /);
  }
  rejected((f) =>
    f.commits.push({
      ...structuredClone(f.commits[0]),
      sha: "old",
      commit: { ...f.commits[0].commit, message: "missing key" },
    }),
  );
  rejected((f) => (f.commits = []));
});
test("API paginates and validates only PR commits, detects races and truncation", async () => {
  const f = fixture();
  f.pr.commits = 101;
  const calls = [];
  const api = async (path) => {
    calls.push(path);
    if (path.endsWith("&page=1")) return Array(100).fill(f.commits[0]);
    if (path.endsWith("&page=2")) return f.commits;
    return structuredClone(f.pr);
  };
  const result = await readPullRequest(config, 7, api);
  assert.equal(result.commits.length, 101);
  assert.equal(calls.length, 4);
  await assert.rejects(
    readPullRequest(config, 7, async (path) => (path.includes("/commits") ? [] : f.pr)),
    /Incomplete/,
  );
  let count = 0;
  await assert.rejects(
    readPullRequest(config, 7, async (path) =>
      path.includes("/commits")
        ? path.endsWith("&page=1")
          ? Array(100).fill(f.commits[0])
          : f.commits
        : { ...f.pr, head: { ...f.pr.head, sha: String(count++) } },
    ),
    /changed/,
  );
  await assert.rejects(readPullRequest(config, Number("$(id)"), api), /Invalid/);
});
test("bootstrap is additive, idempotent, independent of local account paths and rejects symlinks", () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-fixture-"));
  const files = setup(root, config);
  setup(root, config);
  for (const file of files)
    assert.equal(readFileSync(join(root, file), "utf8").match(/Read AGENTS.md/g).length, 1);
  assert.match(
    readFileSync(join(root, ".agents/rules/development-workflow.md"), "utf8"),
    /^---\ntrigger: always_on\n---/,
  );
  const bad = mkdtempSync(join(tmpdir(), "workflow-symlink-"));
  mkdirSync(join(bad, "outside"));
  symlinkSync(join(bad, "outside"), join(bad, ".claude"));
  assert.throws(() => setup(bad, config), /symlink/);
  assert.throws(() => validateConfig({ ...config, projectKeys: [".*"] }), /Invalid/);
});

test("real Git merge/squash/rebase artifacts preserve keyed subjects and tested tree", async () => {
  const { execFileSync } = await import("node:child_process");
  const { writeFileSync } = await import("node:fs");
  for (const strategy of ["merge", "squash", "rebase"]) {
    const cwd = mkdtempSync(join(tmpdir(), "workflow-git-fixture-"));
    const git = (...args) =>
      execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    git("init", "--initial-branch=trunk");
    git("config", "user.name", "Fixture Developer");
    git("config", "user.email", "fixture@example.invalid");
    writeFileSync(join(cwd, "base"), "base");
    git("add", ".");
    git("commit", "-m", "Historical base without a key");
    git("checkout", "-b", "DEMO-42-add-validation");
    writeFileSync(join(cwd, "change"), "change");
    git("add", ".");
    git("commit", "-m", "[DEMO-42] feat: add validation");
    const testedTree = git("rev-parse", "HEAD^{tree}");
    git("checkout", "trunk");
    if (strategy === "merge")
      git("merge", "--no-ff", "DEMO-42-add-validation", "-m", "[DEMO-42] feat: add validation");
    if (strategy === "squash") {
      git("merge", "--squash", "DEMO-42-add-validation");
      git("commit", "-m", "[DEMO-42] feat: add validation");
    }
    if (strategy === "rebase") {
      git("checkout", "DEMO-42-add-validation");
      git("rebase", "trunk");
      git("checkout", "trunk");
      git("merge", "--ff-only", "DEMO-42-add-validation");
    }
    assert.equal(git("rev-parse", "HEAD^{tree}"), testedTree, strategy);
    assert.match(git("log", "-1", "--format=%s"), /^\[DEMO-42\] feat: /, strategy);
  }
});
