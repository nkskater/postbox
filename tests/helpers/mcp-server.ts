import http from "node:http";
import type { AddressInfo } from "node:net";
export async function startMcpFixture() {
  const sessions = new Set<string>(),
    requests: { method: string; url: string; authorization?: string; session?: string }[] = [];
  let sequence = 0;
  const server = http.createServer(async (req, res) => {
    requests.push({
      method: req.method!,
      url: req.url!,
      authorization: req.headers.authorization,
      session: req.headers["mcp-session-id"] as string | undefined,
    });
    if (req.url === "/auth") {
      res.writeHead(401, { "WWW-Authenticate": "Bearer" });
      res.end("credential-failure-secret");
      return;
    }
    if (req.url === "/redirect") {
      res.writeHead(307, { Location: "http://localhost:1/forbidden" });
      res.end();
      return;
    }
    if (req.method === "GET") {
      res.writeHead(405);
      res.end();
      return;
    }
    if (req.method === "DELETE") {
      sessions.delete(String(req.headers["mcp-session-id"]));
      res.writeHead(200);
      res.end("{}");
      return;
    }
    let raw = "";
    for await (const part of req) raw += part;
    const message = JSON.parse(raw);
    if (message.id === undefined) {
      res.writeHead(202);
      res.end();
      return;
    }
    let result: unknown;
    const p = message.params ?? {};
    switch (message.method) {
      case "initialize": {
        const id = "fixture-" + ++sequence;
        sessions.add(id);
        res.setHeader("mcp-session-id", id);
        result = {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {}, resources: {}, prompts: {} },
          serverInfo: { name: "Fixture MCP", version: "1.0.0" },
          instructions: "Fixture instructions <script>never execute</script>",
        };
        break;
      }
      case "tools/list":
        result = {
          tools: [
            {
              name: p.cursor ? "second" : "echo",
              description: "Echo supplied arguments",
              inputSchema: { type: "object", properties: { value: { type: "string" } } },
            },
          ],
          ...(p.cursor ? {} : { nextCursor: "page-2" }),
        };
        break;
      case "resources/list":
        result = { resources: [{ uri: "fixture://hello", name: "Hello resource", mimeType: "text/plain" }] };
        break;
      case "resources/templates/list":
        result = { resourceTemplates: [{ uriTemplate: "fixture://{name}", name: "Named resource" }] };
        break;
      case "resources/read":
        result = { contents: [{ uri: p.uri, mimeType: "text/plain", text: "Hello resource" }] };
        break;
      case "prompts/list":
        result = { prompts: [{ name: "greet", arguments: [{ name: "name", required: true }] }] };
        break;
      case "prompts/get":
        result = {
          messages: [{ role: "user", content: { type: "text", text: "Hello " + p.arguments?.name } }],
        };
        break;
      case "tools/call":
        if (p.name === "slow") {
          setTimeout(() => {
            if (!res.destroyed) {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [] } }));
            }
          }, 1000);
          return;
        } else
          result = {
            content: [{ type: "text", text: JSON.stringify(p.arguments ?? {}) }],
            isError: p.name === "error",
          };
        break;
      default:
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32601, message: "Unsupported fixture operation" },
          }),
        );
        return;
    }
    const body = JSON.stringify({ jsonrpc: "2.0", id: message.id, result });
    if (req.url === "/sse" && message.method === "tools/call") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end("event: message\ndata: " + body + "\n\n");
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(body);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    sessions,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
