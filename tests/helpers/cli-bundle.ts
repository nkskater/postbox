import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * Builds the CLI into `directory/bundle` and returns the entry file. Each suite
 * gets its own complete output, so suites running in parallel never read a
 * shared dist/ while another build is rewriting it.
 */
export async function buildCliBundle(directory: string): Promise<string> {
  const output = path.join(directory, "bundle");
  await exec(process.execPath, ["scripts/build-cli.mjs"], {
    env: { ...process.env, POSTBOX_CLI_OUT: output },
  });
  return path.join(output, "cli.mjs");
}
