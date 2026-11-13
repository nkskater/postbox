import { afterAll, beforeAll, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-expansion-"));
process.env.DATABASE_PATH = path.join(directory, "test.db");
let repo: typeof import("@/server/repo");
let POST: typeof import("@/app/api/proxy/route").POST;
beforeAll(async () => {
  repo = await import("@/server/repo");
  ({ POST } = await import("@/app/api/proxy/route"));
});
afterAll(async () => {
  (await import("@/server/db")).getSqlite().close();
  fs.rmSync(directory, { recursive: true, force: true });
});

it.each(["url", "script body"])(
  "returns a readable proxy execution error for expansion in %s",
  async (target) => {
    const ws = repo.createWorkspace("Expansion");
    const variables: Record<string, string> = {};
    for (let i = 0; i < 10; i++) variables[`v${i}`] = `{{v${i + 1}}}`.repeat(40);
    variables.v10 = "0123456789";
    const env = repo.createEnvironment(
      ws.id,
      "Nested",
      Object.entries(variables).map(([key, value]) => ({
        key,
        value,
        enabled: true,
        type: "default" as const,
      })),
    );
    const response = await POST(
      new Request("http://localhost/api/proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: ws.id,
          environmentId: env.id,
          request:
            target === "url"
              ? { url: "{{v0}}" }
              : {
                  url: "http://127.0.0.1:1/",
                  method: "POST",
                  preRequestScript: `pm.variables.set("payload", "{{v0}}");`,
                  body: { mode: "raw", raw: "{{payload}}", language: "text" },
                },
        }),
      }),
    );
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.error).toMatch(/Variable expansion exceeds \d+ bytes; check for variables/);
    expect(result.response).toBeUndefined();
  },
);
