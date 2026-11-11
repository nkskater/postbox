import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const composeText = read("docker-compose.yml");
const compose = parse(composeText);
const example = Object.fromEntries(
  [...read(".env.example").matchAll(/^([A-Z][A-Z0-9_]*)=(.*)$/gm)].map((m) => [m[1], m[2]]),
);
const documented = [...read("README.md").matchAll(/^\| `([A-Z][A-Z0-9_]*)`\s*\|/gm)].map((m) => m[1]);
// These image settings deliberately stay fixed; .env configures the host port instead.
const fixed = new Set(["DATABASE_PATH", "PORT"]);

describe("Compose configuration coverage", () => {
  it("keeps the README and example in agreement", () => {
    expect(documented.filter((name) => !fixed.has(name)).sort()).toEqual(Object.keys(example).sort());
  });

  it("forwards every documented runtime setting or uses it as a Compose control", () => {
    const controls: Record<string, string> = {
      POSTBOX_PORT: compose.services.postbox.ports[0],
      POSTBOX_MEMORY_LIMIT: compose.services.postbox.mem_limit,
      POSTBOX_CPU_LIMIT: compose.services.postbox.cpus,
      POSTBOX_PIDS_LIMIT: compose.services.postbox.pids_limit,
    };
    for (const name of new Set([...Object.keys(example), ...documented])) {
      if (fixed.has(name)) continue;
      const value = controls[name] ?? compose.services.postbox.environment[name];
      expect(value, `${name} must reach Compose`).toContain(`\${${name}:-`);
    }
    expect(compose.services.postbox.environment.DATABASE_PATH).toBe("/data/postbox.db");
  });
});

const hasCompose = spawnSync("docker", ["compose", "version"], { stdio: "ignore" }).status === 0;
describe.skipIf(!hasCompose)("Docker Compose resolved environment", () => {
  it("forwards .env values and shell overrides without changing unset setting defaults", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "postbox-compose-"));
    try {
      writeFileSync(path.join(dir, "docker-compose.yml"), composeText);
      const values = {
        ...example,
        POSTBOX_SMTP_HOST: "smtp.example.test",
        POSTBOX_SMTP_PORT: "465",
        POSTBOX_SMTP_FROM: "postbox@example.test",
        POSTBOX_SMTP_USER: "test-user",
        POSTBOX_SMTP_PASSWORD: "test-password",
        POSTBOX_SMTP_SECURE: "true",
        POSTBOX_SMTP_REQUIRE_TLS: "false",
        POSTBOX_VAULT_KEY: "a".repeat(64),
        POSTBOX_VAULT_KEY_FILE: "/keys/vault.json",
        POSTBOX_VAULT_PREVIOUS_KEYS: "b".repeat(64),
        POSTBOX_SESSION_SECRET: "test-session-secret",
        MCP_ENABLED: "false",
        MCP_READ_ONLY: "true",
        RESPONSE_MAX_BYTES: "1048576",
        HISTORY_LIMIT: "42",
      };
      writeFileSync(
        path.join(dir, ".env"),
        Object.entries(values)
          .map(([name, value]) => `${name}=${value}`)
          .join("\n"),
      );
      // Do not inherit operator credentials or Compose project/file overrides.
      const env = {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([name]) =>
            ["PATH", "HOME", "SYSTEMROOT", "SystemRoot", "DOCKER_CONFIG"].includes(name),
          ),
        ),
        NODE_ENV: "test" as const,
      };
      const config = (overrides = {}) =>
        JSON.parse(
          execFileSync("docker", ["compose", "--project-directory", dir, "config", "--format", "json"], {
            cwd: dir,
            env: { ...env, ...overrides },
            encoding: "utf8",
          }),
        ).services.postbox.environment;
      const resolved = config();
      for (const [name, value] of Object.entries(values)) {
        if (
          ["POSTBOX_PORT", "POSTBOX_MEMORY_LIMIT", "POSTBOX_CPU_LIMIT", "POSTBOX_PIDS_LIMIT"].includes(name)
        )
          continue;
        expect(resolved[name], name).toBe(value);
      }
      expect(config({ MCP_ENABLED: "true", HISTORY_LIMIT: "17" })).toMatchObject({
        MCP_ENABLED: "true",
        HISTORY_LIMIT: "17",
      });
      writeFileSync(path.join(dir, ".env"), "");
      expect(config()).toMatchObject({
        MCP_ENABLED: "",
        MCP_READ_ONLY: "",
        SCRIPT_TIMEOUT_MS: "",
        SCRIPT_MEMORY_MB: "",
        RUNS_MAX_ACTIVE: "",
        RUNS_MAX_QUEUED: "",
        POSTBOX_SMTP_PORT: "587",
        POSTBOX_SMTP_REQUIRE_TLS: "true",
        RESPONSE_MAX_BYTES: "52428800",
        HISTORY_LIMIT: "500",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
