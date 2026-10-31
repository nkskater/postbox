import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { HttpError, isHttpError } from "@/server/errors";
import { isRunQueueFullError } from "@/server/run-queue";
import { route } from "@/server/http";

/** Load the actual modules independently, as separate Next.js server bundles do. */
function foreignErrors() {
  const context = createContext({
    exports: {},
    require: (name: string) => {
      if (name === "./errors") return errors;
      throw new Error(`Unexpected dependency: ${name}`);
    },
  });
  const load = (name: string) => {
    context.exports = {};
    const source = readFileSync(new URL(`../src/server/${name}.ts`, import.meta.url), "utf8");
    const { outputText } = transpileModule(source, {
      compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
    });
    runInContext(outputText, context);
    return context.exports;
  };
  const errors = load("errors") as typeof import("@/server/errors");
  const queue = load("run-queue") as typeof import("@/server/run-queue");
  return { errors, queue };
}

const request = () => new Request("http://localhost/api/health");

describe("HTTP errors across independently loaded bundles", () => {
  it("preserves queue-full status and scheduler recognition without constructor identity", async () => {
    const foreign = foreignErrors();
    const error = new foreign.queue.RunQueueFullError({ maxActive: 1, maxQueued: 2 });
    expect(error).not.toBeInstanceOf(HttpError);
    expect(isHttpError(error)).toBe(true);
    expect(isRunQueueFullError(error)).toBe(true);
    expect(isRunQueueFullError(new foreign.errors.HttpError(429, "Other rate limit"))).toBe(false);
    const response = await route((_request: Request) => {
      throw error;
    })(request());
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: error.message });
  });

  it("keeps ordinary status-shaped exceptions sanitized", async () => {
    const error = Object.assign(new Error("private storage detail"), { status: 429 });
    expect(isHttpError(error)).toBe(false);
    expect(isHttpError({ status: 429, message: "pretend queue error" })).toBe(false);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const response = await route((_request: Request) => {
        throw error;
      })(request());
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "Internal error" });
    } finally {
      log.mockRestore();
    }
  });
});
