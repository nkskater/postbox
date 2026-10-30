import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { HttpError, json, notFound, parseBody, route } from "@/server/http";

afterEach(() => vi.restoreAllMocks());

describe("API error responses", () => {
  it.each([
    {
      name: "an Error with internal details",
      value: new Error("SQLITE_ERROR: /data/private.db token=secret"),
    },
    {
      name: "an Error with a cause",
      value: new Error("Database failed", { cause: new Error("password=secret") }),
    },
    { name: "a string", value: "Bearer secret" },
    { name: "an object", value: { message: "private hostname", token: "secret" } },
    { name: "null", value: null },
    { name: "undefined", value: undefined },
    { name: "a number", value: 42 },
    { name: "a symbol", value: Symbol("secret") },
  ])("isolates details when a handler throws $name", async ({ value }) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const handlers = [
      route(() => {
        throw value;
      }),
      route(async () => {
        throw value;
      }),
    ];
    for (const handler of handlers) {
      const response = await handler();
      expect(response.status).toBe(500);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(await response.json()).toEqual({ error: "Internal error" });
      // Log the original value so Error stacks and causes remain available server-side.
      expect(log).toHaveBeenLastCalledWith("[postbox] unhandled API error:", value);
    }
    expect(log).toHaveBeenCalledTimes(2);
  });

  it.each([
    new HttpError(400, "Missing workspaceId"),
    notFound("Request"),
    new HttpError(409, "Schedule is already running"),
  ])("preserves deliberate HTTP errors ($status)", async (error) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await route(() => {
      throw error;
    })();
    expect(response.status).toBe(error.status);
    expect(await response.json()).toEqual({ error: error.message });
    expect(log).not.toHaveBeenCalled();
  });

  it("keeps validation issues useful without returning the submitted value", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const schema = z.object({ count: z.number() });
    const handler = route(async (req: Request) => json(await parseBody(req, schema)));
    const response = await handler(
      new Request("http://postbox.test/api/example", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ count: "private-value" }),
      }),
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toMatchObject({
      error: "Invalid input",
      issues: [{ path: ["count"], code: "invalid_type" }],
    });
    expect(JSON.stringify(body)).not.toContain("private-value");
    expect(log).not.toHaveBeenCalled();
  });

  it("returns a deliberate 400 for malformed JSON", async () => {
    const handler = route(async (req: Request) => json(await parseBody(req, z.object({}))));
    const response = await handler(
      new Request("http://postbox.test/api/example", {
        method: "POST",
        body: "{invalid",
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Body must be valid JSON" });
  });

  it("passes through a successful handler response and arguments", async () => {
    const response = json({ ok: true }, 201);
    const handler = route((id: string) => {
      expect(id).toBe("request-id");
      return response;
    });
    expect(await handler("request-id")).toBe(response);
  });
});
