import { execFile } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execute = promisify(execFile);

async function smoke(tree: unknown, delayMs = 0, status = 200) {
  const server = http.createServer((request, response) => {
    if (request.url === "/api/workspaces") {
      response.end(JSON.stringify([{ id: "workspace" }]));
    } else if (request.url === "/api/workspaces/workspace/tree") {
      setTimeout(() => {
        response.writeHead(status);
        response.end(JSON.stringify(tree));
      }, delayMs);
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as import("node:net").AddressInfo;
  try {
    return await execute(
      process.execPath,
      [path.resolve("scripts/check-cold-route.mjs"), `http://127.0.0.1:${address.port}`],
      { timeout: 15_000 },
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

describe("container cold-route smoke check", () => {
  it("accepts a valid cold tree response within the latency budget", async () => {
    const result = await smoke({ folders: [], requests: [] });
    expect(result.stdout).toMatch(/Cold workspace tree route: .*limit <500 ms/);
  });
  it("rejects a route exceeding 500 ms", async () => {
    await expect(smoke({ folders: [], requests: [] }, 650)).rejects.toMatchObject({
      stderr: expect.stringContaining("Cold route exceeded 500 ms"),
    });
  });
  it("rejects HTTP failures instead of treating them as fast responses", async () => {
    await expect(smoke({ error: "unavailable" }, 0, 500)).rejects.toMatchObject({
      stderr: expect.stringContaining("HTTP 500"),
    });
  });
  it("rejects a successful response with the wrong tree shape", async () => {
    await expect(smoke({})).rejects.toMatchObject({
      stderr: expect.stringContaining("Invalid workspace tree response"),
    });
  });
});
