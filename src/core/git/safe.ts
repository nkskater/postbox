/**
 * Validation for the Git adapter: what a branch name, remote URL or repository configuration may look like
 * before Postbox lets git touch it. Pure, so it is tested without running git.
 */

/** Settings in a repository's own config that make git run a program or reach somewhere unreviewed. */
const DANGEROUS_CONFIG = [
  /^core\.(fsmonitor|sshcommand|hookspath|pager|editor|askpass|gitproxy|attributesfile|excludesfile)$/,
  /^core\.worktree$/,
  /^(filter|merge|diff)\..+\.(clean|smudge|process|driver|command|textconv|cmd)$/,
  /^diff\.external$/,
  /^merge\.tool$|^mergetool\./,
  /^credential(\..+)?\.(helper|username|usehttppath)$/,
  /^alias\./,
  /^include(if)?\./,
  /^gpg\..*program$|^gpg\.program$|^gpg\.ssh\.program$/,
  /^url\..+\.(insteadof|pushinsteadof)$/,
  /^remote\..+\.(vcs|receivepack|uploadpack|proxy|proxyauthmethod)$/,
  /^http\.(proxy|sslcainfo|sslverify|cookiefile|extraheader)$/,
  /^receive\.|^uploadpack\./,
  /^submodule\..+\.(update|url)$/,
  /^sequence\.editor$|^sendemail\./,
];

/** Names of settings in a `git config --list` dump that could run a program or redirect traffic. */
export function dangerousConfig(keys: string[]): string[] {
  return [
    ...new Set(
      keys.map((key) => key.toLowerCase()).filter((key) => DANGEROUS_CONFIG.some((rule) => rule.test(key))),
    ),
  ].sort();
}

/** Parse the NUL separated output of `git config --local --list -z` into its (lower-cased) keys. */
export function configKeys(dump: string): string[] {
  return dump
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const newline = entry.indexOf("\n");
      return newline === -1 ? entry : entry.slice(0, newline);
    });
}

const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
/** Throws unless the name is a plain branch name that can never be mistaken for an option or a path trick. */
export function assertBranchName(name: string): string {
  if (
    !BRANCH.test(name) ||
    name.includes("..") ||
    name.includes("//") ||
    name.endsWith("/") ||
    name.endsWith(".") ||
    name.endsWith(".lock") ||
    name.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock")) ||
    name === "HEAD"
  )
    throw new GitUsageError(`"${name}" is not a usable branch name.`);
  return name;
}

export class GitUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitUsageError";
  }
}

export interface RemoteTarget {
  /** The URL exactly as git should receive it. */
  url: string;
  /** The host to check against the outbound policy; null for a local path. */
  host: string | null;
  protocol: "https" | "ssh" | "file";
}

/**
 * Accepts `https://host/path`, `ssh://user@host/path` and `user@host:path`. Credentials in the URL are
 * refused (they would end up in `.git/config`), as are every other transport (`ext::`, `git://`, `http://`).
 * A local path is only accepted when the caller says local remotes are allowed.
 */
export function parseRemote(raw: string, options: { allowLocal?: boolean } = {}): RemoteTarget {
  const url = raw.trim();
  if (!url || (/[\s\0"'`\\]/.test(url) && !/^[A-Za-z]:\\/.test(url)))
    throw new GitUsageError("Enter a remote URL without spaces or quotes.");
  if (url.startsWith("-")) throw new GitUsageError("A remote URL cannot start with a dash.");
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(url);
  if (scheme) {
    const protocol = scheme[1].toLowerCase();
    if (protocol !== "https" && protocol !== "ssh" && protocol !== "file")
      throw new GitUsageError(`Remote URLs must use https or ssh, not ${protocol}.`);
    if (protocol === "file") {
      if (!options.allowLocal) throw new GitUsageError("Local file remotes need --allow-local.");
      return { url, host: null, protocol: "file" };
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new GitUsageError("That is not a valid remote URL.");
    }
    if (protocol === "https" && (parsed.username || parsed.password))
      throw new GitUsageError("Do not put credentials in the remote URL; pass them with --token-env.");
    if (protocol === "ssh" && parsed.password)
      throw new GitUsageError("Do not put a password in the remote URL.");
    if (!parsed.hostname) throw new GitUsageError("The remote URL has no host.");
    return { url, host: parsed.hostname.replace(/^\[|\]$/g, ""), protocol };
  }
  const scp = /^(?:[A-Za-z0-9._-]+@)?([A-Za-z0-9.-]+):(?!\/\/)(.+)$/.exec(url);
  if (scp && !/^[A-Za-z]:[\\/]/.test(url)) return { url, host: scp[1], protocol: "ssh" };
  if (options.allowLocal) return { url, host: null, protocol: "file" };
  throw new GitUsageError("Remote URLs must be https://, ssh:// or user@host:path.");
}

/** Remove a secret (and its percent-encoded form) from text that is about to be shown or logged. */
export function scrub(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length < 4) continue;
    out = out.split(secret).join("[REDACTED]").split(encodeURIComponent(secret)).join("[REDACTED]");
  }
  return out;
}
