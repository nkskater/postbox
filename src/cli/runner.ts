import type { Command } from "commander";
import { version } from "../../package.json";
import { AgentAuthError, runAgent } from "../core/runner-agent/agent";
import { CliError, EXIT } from "./errors";

const split = (value?: string) =>
  value
    ? value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];

/** Local values the runner holds itself: POSTBOX_RUNNER_VAR_<name>=<value>. They never travel to the server. */
export function localVariables(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env))
    if (key.startsWith("POSTBOX_RUNNER_VAR_") && value !== undefined && key.length > 19)
      out[key.slice("POSTBOX_RUNNER_VAR_".length)] = value;
  return out;
}

function checkServer(raw: string, allowInsecure?: boolean) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CliError("--server must be a URL such as https://postbox.example.com", EXIT.usage);
  }
  const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && (loopback || allowInsecure)))
    throw new CliError(
      "The runner token would travel unencrypted. Use an https:// server, or pass --allow-insecure.",
      EXIT.usage,
    );
  return url.origin + url.pathname.replace(/\/+$/, "");
}

/** Adds `postbox runner start` to the `runner` group created by registerManagement. */
export function registerRunnerAgent(program: Command) {
  const group = program.commands.find((command) => command.name() === "runner");
  if (!group) throw new Error("registerManagement must run first");
  group
    .command("start")
    .description("Run as a private runner: lease monitor checks from a server and execute them locally")
    .requiredOption("--server <url>", "Postbox server URL")
    .option("--token-env <name>", "Environment variable holding the runner token", "POSTBOX_RUNNER_TOKEN")
    .option("--poll <seconds>", "Seconds to wait between polls when idle", "5")
    .option("--once", "Run what is queued, then exit")
    .option("--allow-insecure", "Allow a plain http:// server (the token is sent unencrypted)")
    .action(
      async (options: {
        server: string;
        tokenEnv: string;
        poll: string;
        once?: boolean;
        allowInsecure?: boolean;
      }) => {
        const token = process.env[options.tokenEnv];
        if (!token) throw new CliError(`Set ${options.tokenEnv} to the runner token.`, EXIT.usage);
        const server = checkServer(options.server, options.allowInsecure);
        const poll = Number(options.poll);
        if (!Number.isFinite(poll) || poll < 1 || poll > 300)
          throw new CliError("--poll must be 1-300 seconds.", EXIT.usage);
        const controller = new AbortController();
        for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => controller.abort());
        const log = (message: string) => console.error(`[runner] ${message}`);
        log(`connecting to ${server}`);
        try {
          const { jobs } = await runAgent({
            server,
            token,
            version,
            pollMs: poll * 1000,
            once: options.once,
            signal: controller.signal,
            log,
            local: {
              variables: localVariables(),
              allowHosts: split(process.env.PROXY_ALLOW_HOSTS),
              denyHosts: split(process.env.PROXY_DENY_HOSTS),
              allowSockets: split(process.env.PROXY_ALLOW_SOCKETS),
            },
          });
          log(`stopped after ${jobs} check(s)`);
        } catch (error) {
          if (error instanceof AgentAuthError) throw new CliError(error.message, EXIT.auth);
          throw new CliError((error as Error).message, EXIT.network);
        }
      },
    );
}
