import type { Command } from "commander";
import * as git from "../core/git/adapter";
import { HostPolicy, HostPolicyError } from "../core/http/policy";
import { CliError, EXIT } from "./errors";

const split = (value?: string) => (value?.trim() ? value.split(",") : []);

interface Common {
  dir: string;
  tokenEnv?: string;
  username?: string;
  allowLocal?: boolean;
  name?: string;
  email?: string;
  json?: boolean;
}

function gitOptions(common: Common): git.GitOptions {
  const author =
    common.name || common.email
      ? { name: common.name ?? "Postbox", email: common.email ?? "postbox@localhost" }
      : undefined;
  return {
    policy: new HostPolicy(split(process.env.PROXY_ALLOW_HOSTS), split(process.env.PROXY_DENY_HOSTS)),
    allowLocal: common.allowLocal,
    tokenEnv: common.tokenEnv,
    username: common.username,
    author,
  };
}

async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof git.GitUsageError) throw new CliError(error.message, EXIT.usage);
    if (error instanceof HostPolicyError) throw new CliError(error.message, EXIT.invalid);
    if (error instanceof git.GitError) throw new CliError(error.message, EXIT.failure);
    throw error;
  }
}

function describe(status: git.GitStatus) {
  if (!status.repository) return "Not a git repository yet.";
  const lines = [
    `On branch ${status.branch ?? "(detached)"}${status.upstream ? ` tracking ${status.upstream}` : ""}` +
      (status.ahead || status.behind ? ` (ahead ${status.ahead}, behind ${status.behind})` : ""),
  ];
  if (status.merging) lines.push("A merge is in progress.");
  if (status.clean) lines.push("Working tree clean.");
  for (const change of status.changes)
    lines.push(`  ${change.state.padEnd(10)} ${change.from ? `${change.from} -> ` : ""}${change.path}`);
  return lines.join("\n");
}

function show(status: git.GitStatus, json?: boolean) {
  console.log(json ? JSON.stringify(status, null, 2) : describe(status));
}

export function registerGit(program: Command) {
  const root = program
    .command("git")
    .description("Keep a pulled collection directory in Git: connect, status, commit, branch, push and pull.")
    .exitOverride();
  const common = (command: Command) =>
    command
      .requiredOption("-d, --dir <path>", "Directory created by `collection pull`")
      .option("--token-env <name>", "Environment variable holding the access token for https remotes")
      .option("--username <name>", "Username that goes with the token (default x-access-token)")
      .option("--allow-local", "Allow remotes that are local paths")
      .option("--name <name>", "Commit author name (default Postbox)")
      .option("--email <email>", "Commit author email")
      .option("--json", "Print JSON");
  const run =
    (fn: (opts: Common, command: Command) => Promise<void>) =>
    async (...raw: unknown[]) => {
      const command = raw[raw.length - 1] as Command;
      await guard(() => fn(command.opts<Common>(), command));
    };

  common(root.command("connect").description("Make the directory a repository and set its remote"))
    .option("--remote <url>", "https:// or ssh remote (no credentials in the URL)")
    .option("--branch <name>", "Branch to start on", "main")
    .action(
      run(async (opts, command) => {
        const { remote, branch } = command.opts<{ remote?: string; branch: string }>();
        show(await git.connect(opts.dir, { remote, branch }, gitOptions(opts)), opts.json);
      }),
    );
  common(root.command("status").description("Show the branch and the changed files")).action(
    run(async (opts) => show(await git.status(opts.dir, gitOptions(opts)), opts.json)),
  );
  common(root.command("diff").description("Show uncommitted changes")).action(
    run(async (opts) => {
      process.stdout.write(await git.diff(opts.dir, gitOptions(opts)));
    }),
  );
  common(root.command("commit").description("Commit every change in the directory"))
    .requiredOption("-m, --message <text>", "Commit message")
    .action(
      run(async (opts, command) => {
        const result = await git.commit(
          opts.dir,
          command.opts<{ message: string }>().message,
          gitOptions(opts),
        );
        console.log(result.summary);
      }),
    );
  const branch = root.command("branch").description("List, create or switch branches").exitOverride();
  common(branch.command("list").description("List branches")).action(
    run(async (opts) => {
      const { current, names } = await git.branches(opts.dir, gitOptions(opts));
      for (const name of names) console.log(`${name === current ? "*" : " "} ${name}`);
    }),
  );
  common(branch.command("create <name>").description("Create a branch and switch to it")).action(
    async (name: string, _o: unknown, command: Command) =>
      guard(async () => {
        const opts = command.opts<Common>();
        show(await git.createBranch(opts.dir, name, gitOptions(opts)), opts.json);
      }),
  );
  common(branch.command("switch <name>").description("Switch to a branch")).action(
    async (name: string, _o: unknown, command: Command) =>
      guard(async () => {
        const opts = command.opts<Common>();
        show(await git.switchBranch(opts.dir, name, gitOptions(opts)), opts.json);
      }),
  );
  common(root.command("push").description("Push the current branch to origin")).action(
    run(async (opts) => {
      const result = await git.push(opts.dir, gitOptions(opts));
      console.log(`Pushed ${result.branch}.`);
    }),
  );
  common(
    root.command("pull").description("Fetch origin and merge the current branch; conflicts are left for you"),
  ).action(
    run(async (opts) => {
      const result = await git.pull(opts.dir, gitOptions(opts));
      if (result.outcome === "conflict") {
        console.log(`Conflicts in:\n${result.conflicts.map((file) => `  ${file}`).join("\n")}`);
        console.log("Edit the files, then run `postbox git continue`, or `postbox git abort`.");
        process.exitCode = EXIT.invalid;
        return;
      }
      console.log(`${result.outcome}: ${result.summary}`);
      if (result.outcome !== "up-to-date")
        console.log("Apply it to Postbox with `postbox collection push --dir <dir>`.");
    }),
  );
  common(root.command("continue").description("Finish a merge after resolving its conflicts")).action(
    run(async (opts) => console.log((await git.continueMerge(opts.dir, gitOptions(opts))).summary)),
  );
  common(root.command("abort").description("Abandon a merge in progress")).action(
    run(async (opts) => {
      await git.abortMerge(opts.dir, gitOptions(opts));
      console.log("Merge aborted.");
    }),
  );
}
