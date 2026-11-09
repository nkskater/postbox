/**
 * `.env` files <-> Postbox environment variables, with explicit controls over secrets. Nothing here touches
 * the file system or the network, so it is unit tested directly.
 */
import type { Variable } from "../../../../src/core/types";

/** Names that almost always hold a credential. */
export const SECRET_NAME = /(secret|token|passw|pwd|api[_-]?key|private|credential|auth|signature|cert)/i;

export interface DotenvEntry {
  key: string;
  value: string;
}

/** Parses the common `.env` dialect: comments, `export`, single/double quotes, `\n` in double quotes, inline comments. */
export function parseDotenv(text: string): DotenvEntry[] {
  const out = new Map<string, string>();
  for (const rawLine of text.replace(/^﻿/, "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rest] = match;
    let value = rest.trim();
    if (value.startsWith('"')) {
      const end = value.indexOf('"', 1);
      value = (end === -1 ? value.slice(1) : value.slice(1, end))
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
    } else if (value.startsWith("'")) {
      const end = value.indexOf("'", 1);
      value = end === -1 ? value.slice(1) : value.slice(1, end);
    } else {
      const comment = value.search(/\s#/);
      if (comment !== -1) value = value.slice(0, comment);
      value = value.trim();
    }
    out.set(key, value);
  }
  return [...out].map(([key, value]) => ({ key, value }));
}

export interface ImportOptions {
  /** Keys to treat as secret regardless of their name. */
  secretKeys?: string[];
  /** Keys to treat as plain even though their name looks secret. */
  plainKeys?: string[];
  /** Import the value of secret keys, or leave them blank so only the name is created. Default: blank. */
  includeSecretValues?: boolean;
  /** Only these keys (default: all). */
  only?: string[];
  /** Replace the value of keys that already exist. Default: keep what Postbox has. */
  overwrite?: boolean;
}

export interface ImportPlan {
  variables: Variable[];
  added: string[];
  updated: string[];
  unchanged: string[];
  /** Keys imported as secret. */
  secrets: string[];
  /** Secret keys whose value was deliberately not imported. */
  withheld: string[];
}

export const isSecretKey = (key: string, options: ImportOptions = {}) =>
  options.secretKeys?.includes(key) ? true : options.plainKeys?.includes(key) ? false : SECRET_NAME.test(key);

/** Merges `.env` entries into an environment's existing variables without ever dropping the user's other ones. */
export function planDotenvImport(
  existing: Variable[],
  entries: DotenvEntry[],
  options: ImportOptions = {},
): ImportPlan {
  const variables = existing.map((variable) => ({ ...variable }));
  const plan: ImportPlan = { variables, added: [], updated: [], unchanged: [], secrets: [], withheld: [] };
  for (const { key, value } of entries) {
    if (options.only && !options.only.includes(key)) continue;
    const secret = isSecretKey(key, options);
    const carried = secret && !options.includeSecretValues ? "" : value;
    if (secret) {
      plan.secrets.push(key);
      if (!options.includeSecretValues) plan.withheld.push(key);
    }
    const at = variables.findIndex((variable) => variable.key === key);
    if (at === -1) {
      variables.push({ key, value: carried, type: secret ? "secret" : "default", enabled: true } as Variable);
      plan.added.push(key);
    } else if (!options.overwrite || variables[at].value === carried || (secret && carried === "")) {
      plan.unchanged.push(key);
    } else {
      variables[at] = { ...variables[at], value: carried, type: secret ? "secret" : variables[at].type };
      plan.updated.push(key);
    }
  }
  return plan;
}

const quote = (value: string) =>
  /^[A-Za-z0-9_./:@%+=,-]*$/.test(value)
    ? value
    : `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;

/** Writes enabled variables as `.env` text. Secrets are left out unless the caller opts in. */
export function toDotenv(
  variables: Variable[],
  options: { includeSecrets?: boolean } = {},
): { text: string; omitted: string[] } {
  const omitted: string[] = [];
  const lines: string[] = [];
  for (const variable of variables) {
    if (!variable.enabled || !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(variable.key)) continue;
    if ((variable.type === "secret" || SECRET_NAME.test(variable.key)) && !options.includeSecrets) {
      omitted.push(variable.key);
      continue;
    }
    lines.push(`${variable.key}=${quote(variable.value)}`);
  }
  return { text: lines.length ? lines.join("\n") + "\n" : "", omitted };
}
