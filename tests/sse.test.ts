import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { SseParser, streamEvents, type SseEvent, type SseMessage } from "@/core/http/sse";
import { HostPolicy } from "@/core/http/policy";
import type { PreparedRequest } from "@/core/types";
import { DEFAULT_SETTINGS } from "@/core/types";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-sse-"));
process.env.DATABASE_PATH = path.join(dir, "test.db");

function parse(chunks: string[]) {
  const events: SseEvent[] = [];
  const parser = new SseParser((e) => events.push(e));
  for (const c of chunks) parser.feed(c);
  return { events, parser };
}

describe("SseParser", () => {
  const stream =
    "﻿: comment\r\nretry: 1500\r\nevent: greet\r\nid: 1\r\ndata: hello\r\ndata:  world\r\n\r\n" +
    "data: second\n\nid: bad\0id\ndata: keeps id\r\rdata\n\nevent: empty\n\n";
  const expected = [
    { event: "greet", data: "hello\n world", id: "1" },
    { event: "message", data: "second", id: "1" },
    { event: "message", data: "keeps id", id: "1" },
    { event: "message", data: "", id: "1" },
  ];

  it("parses fields, comments, BOM, mixed line endings and multi-line data", () => {
    const { events, parser } = parse([stream]);
    expect(events).toEqual(expected);
    expect(parser.retry).toBe(1500);
  });

  it("gives the same result for every chunking, including split CRLF", () => {
    expect(parse([...stream]).events).toEqual(expected);
    for (let i = 1; i < stream.length; i++)
      expect(parse([stream.slice(0, i), stream.slice(i)]).events).toEqual(expected);
  });
});

const seenIds: (string | undefined)[] = [];
let connections = 0;
let base = "";
const server = http.createServer((req, res) => {
  if (req.url === "/json") return res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
  connections++;
  seenIds.push(req.headers["last-event-id"] as string | undefined);
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  if (req.url === "/forever") {
    const timer = setInterval(() => res.write(`data: tick\n\n`), 10);
    req.on("close", () => clearInterval(timer));
    return;
  }
  // Two events split mid-field across writes, then the server ends the stream.
  const start = Number(req.headers["last-event-id"] ?? 0);
  res.write("retry: 20\nid: " + (start + 1) + "\nda");
  setTimeout(() => res.write(`ta: e${start + 1}\n\nid: ${start + 2}\ndata: e${start + 2}\n`), 5);
  setTimeout(() => res.end("\n"), 10);
});
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const req = (p: string): PreparedRequest => ({
  method: "GET",
  url: base + p,
  headers: [],
  settings: DEFAULT_SETTINGS,
});
async function collect(p: string, opts: Parameters<typeof streamEvents>[2] = {}) {
  const messages: SseMessage[] = [];
  await streamEvents(req(p), (m) => messages.push(m), opts);
  return messages;
}

describe("streamEvents", () => {
  it("reconnects with Last-Event-ID using the server's retry delay", async () => {
    seenIds.length = 0;
    const messages = await collect("/events", { maxReconnects: 1, retryMs: 5000 });
    const events = messages.filter((m) => m.type === "event");
    expect(events.map((e) => [e.data, e.id])).toEqual([
      ["e1", "1"],
      ["e2", "2"],
      ["e3", "3"],
      ["e4", "4"],
    ]);
    expect(seenIds).toEqual([undefined, "2"]);
    expect(messages.find((m) => m.type === "reconnecting")).toMatchObject({ delayMs: 20, lastEventId: "2" });
    expect(messages.at(-1)).toEqual({ type: "closed", reason: "Server ended the stream", events: 4 });
  });

  it("stops at the event limit and when cancelled", async () => {
    expect((await collect("/forever", { maxEvents: 3 })).at(-1)).toEqual({
      type: "closed",
      reason: "Stopped after 3 events",
      events: 3,
    });
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 50);
    const messages = await collect("/forever", { signal: ctrl.signal, maxEvents: 10_000 });
    expect(messages.at(-1)).toMatchObject({ type: "closed", reason: "Cancelled" });
  });

  it("does not retry responses that are not event streams, or blocked hosts", async () => {
    const before = connections;
    expect((await collect("/json", { maxReconnects: 5 })).at(-1)).toEqual({
      type: "closed",
      reason: "Not an event stream (HTTP 200, application/json)",
      events: 0,
    });
    expect(connections).toBe(before);
    const blocked = await collect("/events", { policy: new HostPolicy([], ["127.0.0.1"]), maxReconnects: 5 });
    expect(blocked).toEqual([
      { type: "closed", reason: expect.stringMatching(/PROXY_DENY_HOSTS/), events: 0 },
    ]);
  });
});

describe("POST /api/sse", () => {
  it("relays events as NDJSON with workspace variables, auth and secret redaction", async () => {
    const secretServer = http.createServer((r, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(`data: auth=${r.headers.authorization} accept=${r.headers.accept}\n\n`);
    });
    await new Promise<void>((r) => secretServer.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(secretServer.address() as AddressInfo).port}`;
    try {
      const repo = await import("@/server/repo");
      const { POST } = await import("@/app/api/sse/route");
      const ws = repo.createWorkspace("SSE");
      const folder = repo.createFolder(ws.id, null, { name: "c" });
      repo.replaceVariables(ws.id, "collection", folder.id, [
        { key: "host", value: url, type: "default", enabled: true },
        { key: "token", value: "sse-secret-token", type: "secret", enabled: true },
      ]);
      const res = await POST(
        new Request("http://localhost/api/sse", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspaceId: ws.id,
            folderId: folder.id,
            maxReconnects: 0,
            request: { url: "{{host}}/", auth: { type: "bearer", bearer: { token: "{{token}}" } } },
          }),
        }),
      );
      const lines = (await res.text())
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      expect(lines[0]).toMatchObject({ type: "open", status: 200 });
      expect(lines[1].data).toBe("auth=Bearer ******** accept=text/event-stream");
      expect(lines.at(-1)).toMatchObject({ type: "done", events: 1 });
      expect(JSON.stringify(lines)).not.toContain("sse-secret-token");
      (await import("@/server/db")).getSqlite().close();
    } finally {
      secretServer.close();
    }
  });
});
