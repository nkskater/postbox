import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { ANTHROPIC_VERSION, buildAiPayload, providerHeaders } from "@/core/ai/build";
import { AiAccumulator, createDecoder, errorMessage, parseResponse } from "@/core/ai/parse";
import { DEFAULT_AI_CONFIG, type AiConfig, type AiEvent } from "@/core/ai/types";
import { encodeBody } from "@/core/http/body";
import { SseParser } from "@/core/http/sse";
import { generateCurl } from "@/core/convert/codegen";
import { bodySchema } from "@/core/schemas";
import type { Caller } from "@/server/caller";
import type { UserRow } from "@/server/db/schema";

const config = (patch: Partial<AiConfig> = {}): AiConfig => ({
  ...DEFAULT_AI_CONFIG,
  model: "test-model",
  messages: [{ role: "user", content: "Hello" }],
  ...patch,
});

// ------------------------------------------------------------------ building

describe("request payloads", () => {
  it("builds an OpenAI-compatible body with parameters, tools and usage reporting", () => {
    const payload = buildAiPayload(
      config({
        system: "Be brief",
        temperature: 0.2,
        topP: 0.9,
        maxTokens: 50,
        tools: [
          {
            name: "get_weather",
            description: "Weather",
            parameters: '{"type":"object","properties":{"city":{"type":"string"}}}',
          },
        ],
        toolChoice: "required",
        extra: '{"top_k": 5}',
      }),
    );
    expect(payload).toMatchObject({
      model: "test-model",
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0.2,
      top_p: 0.9,
      max_tokens: 50,
      top_k: 5,
      tool_choice: "required",
    });
    expect((payload.messages as unknown[])[0]).toEqual({ role: "system", content: "Be brief" });
    expect((payload.tools as { function: { name: string } }[])[0].function.name).toBe("get_weather");
  });

  it("builds an Anthropic body with a required token limit and tool schema", () => {
    const payload = buildAiPayload(
      config({
        provider: "anthropic",
        system: "S",
        tools: [{ name: "t", description: "d", parameters: "" }],
        toolChoice: "required",
      }),
    );
    expect(payload).toMatchObject({
      model: "test-model",
      max_tokens: 1024,
      system: "S",
      tool_choice: { type: "any" },
    });
    expect((payload.tools as { input_schema: unknown }[])[0].input_schema).toEqual({
      type: "object",
      properties: {},
    });
    expect(providerHeaders("anthropic")).toEqual([["anthropic-version", ANTHROPIC_VERSION]]);
    expect(providerHeaders("openai")).toEqual([]);
  });

  it("carries a tool round trip in each provider's shape", () => {
    const messages: AiConfig["messages"] = [
      { role: "user", content: "Weather?" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "c1", name: "w", arguments: '{"city":"Oslo"}' },
          { id: "c2", name: "w", arguments: '{"city":"Rome"}' },
        ],
      },
      { role: "tool", toolCallId: "c1", content: "cold" },
      { role: "tool", toolCallId: "c2", content: "warm" },
    ];
    const openai = buildAiPayload(config({ messages })).messages as Record<string, unknown>[];
    expect(openai[1]).toMatchObject({ role: "assistant", content: null });
    expect((openai[1].tool_calls as unknown[]).length).toBe(2);
    expect(openai[2]).toEqual({ role: "tool", tool_call_id: "c1", content: "cold" });
    const anthropic = buildAiPayload(config({ provider: "anthropic", messages })).messages as {
      role: string;
      content: { type: string }[];
    }[];
    expect(anthropic).toHaveLength(3);
    expect(anthropic[1].content.map((b) => b.type)).toEqual(["tool_use", "tool_use"]);
    // Both results answer one assistant turn, so they share one user message.
    expect(anthropic[2].content.map((b) => b.type)).toEqual(["tool_result", "tool_result"]);
  });

  it("keeps malformed tool arguments visible instead of dropping them", () => {
    const anthropic = buildAiPayload(
      config({
        provider: "anthropic",
        messages: [
          { role: "assistant", content: "", toolCalls: [{ id: "x", name: "t", arguments: "{oops" }] },
        ],
      }),
    ).messages as { content: { input: unknown }[] }[];
    expect(anthropic[0].content[0].input).toEqual({ _raw: "{oops" });
  });

  it("rejects incomplete or conflicting configuration with readable messages", () => {
    expect(() => buildAiPayload(config({ model: " " }))).toThrow(/model/i);
    expect(() => buildAiPayload(config({ messages: [] }))).toThrow(/message/i);
    expect(() => buildAiPayload(config({ extra: "{bad" }))).toThrow(/Extra parameters is not valid JSON/);
    expect(() => buildAiPayload(config({ extra: "[1]" }))).toThrow(/object/);
    expect(() => buildAiPayload(config({ extra: '{"stream": false}' }))).toThrow(/cannot set "stream"/);
    expect(() =>
      buildAiPayload(config({ tools: [{ name: "bad name", description: "", parameters: "" }] })),
    ).toThrow(/Tool name/);
    expect(() =>
      buildAiPayload(config({ tools: [{ name: "ok", description: "", parameters: "{nope" }] })),
    ).toThrow(/Parameters of tool "ok"/);
  });

  it("is the body of a request, in code snippets and the schema", () => {
    const body = { mode: "ai" as const, ai: config({ stream: false }) };
    expect(bodySchema.safeParse(body).success).toBe(true);
    expect(bodySchema.safeParse({ mode: "ai", ai: { ...body.ai, provider: "other" } }).success).toBe(false);
    const encoded = encodeBody(body, "POST");
    expect(encoded.contentType).toBe("application/json");
    expect(JSON.parse(encoded.body!.toString())).toMatchObject({ model: "test-model", stream: false });
    const snippet = generateCurl({
      method: "POST",
      url: "https://models.example/v1/chat/completions",
      headers: [],
      body,
    });
    expect(snippet).toContain("test-model");
  });
});

// ------------------------------------------------------------------ decoding

/** Feed provider-formatted text to a decoder in awkward chunks, the way a network would deliver it. */
function decode(provider: "openai" | "anthropic", wire: string, chunk = 7): AiEvent[] {
  const decoder = createDecoder(provider);
  const events: AiEvent[] = [];
  const parser = new SseParser((e) => events.push(...decoder.feed(e.event, e.data)));
  for (let i = 0; i < wire.length; i += chunk) parser.feed(wire.slice(i, i + chunk));
  return events;
}
const sse = (events: { event?: string; data: unknown }[]) =>
  events
    .map(
      (e) =>
        `${e.event ? `event: ${e.event}\n` : ""}data: ${typeof e.data === "string" ? e.data : JSON.stringify(e.data)}\n\n`,
    )
    .join("");

const OPENAI_STREAM = sse([
  { data: { model: "m-1", choices: [{ delta: { role: "assistant", content: "Hel" } }] } },
  { data: { choices: [{ delta: { content: "lo" } }] } },
  { data: { choices: [{ delta: { reasoning_content: "thinking" } }] } },
  {
    data: {
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id: "call_1", function: { name: "get_weather", arguments: '{"ci' } }],
          },
        },
      ],
    },
  },
  { data: { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ty":"Oslo"}' } }] } }] } },
  {
    data: {
      choices: [
        {
          delta: { tool_calls: [{ index: 1, id: "call_2", function: { name: "broken", arguments: "{no" } }] },
        },
      ],
    },
  },
  { data: { choices: [{ delta: {}, finish_reason: "tool_calls" }] } },
  { data: { choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } } },
  { data: "[DONE]" },
]);

describe("streaming decoders", () => {
  it("assembles OpenAI text, reasoning, split tool calls and usage across any chunking", () => {
    for (const chunk of [1, 3, 7, 1000]) {
      const acc = new AiAccumulator();
      for (const e of decode("openai", OPENAI_STREAM, chunk)) acc.add(e);
      const result = acc.result();
      expect(result.text).toBe("Hello");
      expect(result.reasoning).toBe("thinking");
      expect(result.model).toBe("m-1");
      expect(result.finishReason).toBe("tool_calls");
      expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 7, totalTokens: 18 });
      expect(result.toolCalls).toEqual([
        { id: "call_1", name: "get_weather", arguments: '{"city":"Oslo"}', valid: true },
        { id: "call_2", name: "broken", arguments: "{no", valid: false },
      ]);
    }
  });

  it("assembles an Anthropic stream with a tool call and usage", () => {
    const wire = sse([
      {
        event: "message_start",
        data: {
          type: "message_start",
          message: { model: "claude-x", usage: { input_tokens: 25, output_tokens: 1 } },
        },
      },
      {
        event: "content_block_start",
        data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      },
      {
        event: "content_block_delta",
        data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Let me " } },
      },
      {
        event: "content_block_delta",
        data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "check." } },
      },
      {
        event: "content_block_start",
        data: {
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_use", id: "toolu_1", name: "lookup", input: {} },
        },
      },
      {
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: '{"q":' },
        },
      },
      {
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: '"x"}' },
        },
      },
      {
        event: "message_delta",
        data: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 15 } },
      },
      { event: "message_stop", data: { type: "message_stop" } },
      { event: "ping", data: { type: "ping" } },
    ]);
    const acc = new AiAccumulator();
    for (const e of decode("anthropic", wire, 5)) acc.add(e);
    const result = acc.result();
    expect(result).toMatchObject({
      text: "Let me check.",
      model: "claude-x",
      finishReason: "tool_use",
      usage: { inputTokens: 25, outputTokens: 15, totalTokens: 40 },
      toolCalls: [{ id: "toolu_1", name: "lookup", arguments: '{"q":"x"}', valid: true }],
    });
  });

  it("survives garbage, unknown events and mid-stream provider errors", () => {
    expect(decode("openai", "data: not json\n\ndata: [1,2]\n\ndata: {}\n\n")).toEqual([]);
    expect(decode("anthropic", "event: x\ndata: nope\n\n")).toEqual([]);
    const failed = decode("openai", sse([{ data: { error: { message: "rate limited" } } }]));
    expect(failed).toEqual([{ type: "error", message: "rate limited" }]);
    const anthropicFailed = decode(
      "anthropic",
      sse([
        {
          event: "error",
          data: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
        },
      ]),
    );
    expect(anthropicFailed).toEqual([{ type: "error", message: "Overloaded" }]);
  });

  it("bounds hostile tool-call indexes", () => {
    const acc = new AiAccumulator();
    acc.add({ type: "tool_call", index: 1_000_000_000, id: "x", name: "n", argumentsDelta: "{}" });
    expect(acc.result().toolCalls).toHaveLength(1);
  });

  it("reads complete responses and error bodies", () => {
    const openai = parseResponse(
      "openai",
      JSON.stringify({
        model: "m",
        choices: [
          {
            message: { content: "Hi", tool_calls: [{ id: "c", function: { name: "f", arguments: "{}" } }] },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      }),
    );
    expect(openai).toMatchObject({ text: "Hi", finishReason: "stop", usage: { totalTokens: 3 } });
    expect(openai.toolCalls[0]).toMatchObject({ id: "c", name: "f", valid: true });
    const anthropic = parseResponse(
      "anthropic",
      JSON.stringify({
        content: [
          { type: "text", text: "A" },
          { type: "tool_use", id: "t", name: "g", input: { a: 1 } },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 4, output_tokens: 6 },
      }),
    );
    expect(anthropic).toMatchObject({ text: "A", usage: { totalTokens: 10 } });
    expect(anthropic.toolCalls[0].arguments).toBe('{"a":1}');
    expect(parseResponse("openai", "<html>").error).toMatch(/not JSON/);
    expect(parseResponse("openai", '{"error":{"message":"bad key"}}').error).toBe("bad key");
    expect(errorMessage('{"error":"flat"}')).toBe("flat");
    expect(errorMessage("plain text")).toBe("plain text");
  });
});

// ------------------------------------------------------------------ the route, against fake providers

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-ai-"));
process.env.DATABASE_PATH = path.join(dir, "db.sqlite");
const users = await import("@/server/users");
const repo = await import("@/server/repo");
const { withCaller } = await import("@/server/access-context");
const aiRoute = await import("@/app/api/ai/route");

const caller = (user: UserRow): Caller => ({ kind: "user", user, via: "token" });

interface Seen {
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
}
let server: http.Server;
let base = "";
let seen: Seen[] = [];
let owner: UserRow;
let workspaceId: string;
let key = "";

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      seen.push({ url: req.url!, headers: req.headers, body });
      const route = new URL(req.url!, "http://x").pathname;
      if (route === "/openai/stream") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        // Deliver in two writes so events straddle network chunks.
        res.write(OPENAI_STREAM.slice(0, 120));
        setTimeout(() => res.end(OPENAI_STREAM.slice(120)), 10);
      } else if (route === "/anthropic/stream") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(
          sse([
            {
              event: "message_start",
              data: { type: "message_start", message: { model: "c", usage: { input_tokens: 3 } } },
            },
            {
              event: "content_block_delta",
              data: {
                type: "content_block_delta",
                index: 0,
                delta: { type: "text_delta", text: "Hi there" },
              },
            },
            {
              event: "message_delta",
              data: {
                type: "message_delta",
                delta: { stop_reason: "end_turn" },
                usage: { output_tokens: 2 },
              },
            },
          ]),
        );
      } else if (route === "/json") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            model: "m",
            choices: [{ message: { content: "plain answer" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
          }),
        );
      } else if (route === "/unauthorized") {
        res.writeHead(401, { "Content-Type": "application/json" });
        // A careless provider that echoes the credential in its error.
        res.end(
          JSON.stringify({
            error: {
              message: `Incorrect API key provided: ${String(req.headers.authorization).replace("Bearer ", "")}`,
            },
          }),
        );
      } else {
        res.writeHead(404).end();
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  owner = await users.createUser({ username: "owner", password: "password123" });
  key = users.createToken(owner.id, "t").token;
  workspaceId = withCaller(caller(owner), () => repo.createWorkspace("AI").id);
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
});

async function run(path: string, ai: Partial<AiConfig>, extra: Record<string, unknown> = {}) {
  const response = await aiRoute.POST(
    new Request("http://localhost/api/ai", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId,
        request: {
          name: "AI",
          method: "POST",
          url: `${base}${path}`,
          headers: [],
          params: [],
          body: { mode: "ai", ai: config(ai) },
          auth: { type: "bearer", bearer: { token: "sk-live-SECRET-123" } },
          ...extra,
        },
      }),
    }),
  );
  const text = await response.text();
  const messages = text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown> & { type: string });
  return {
    status: response.status,
    text,
    messages,
    done: messages.find((m) => m.type === "done") as
      { result: ReturnType<AiAccumulator["result"]>; status: number } | undefined,
  };
}

describe("the model request route", () => {
  it("streams an OpenAI-compatible answer with tool calls and usage, and sends credentials upstream", async () => {
    seen = [];
    const out = await run("/openai/stream", {
      tools: [{ name: "get_weather", description: "", parameters: "" }],
    });
    expect(out.status).toBe(200);
    const types = out.messages.map((m) => m.type);
    expect(types[0]).toBe("open");
    expect(types.filter((t) => t === "text")).toHaveLength(2);
    expect(types.at(-1)).toBe("done");
    expect(out.done!.result).toMatchObject({
      text: "Hello",
      finishReason: "tool_calls",
      usage: { totalTokens: 18 },
    });
    expect(out.done!.result.toolCalls.map((c) => c.name)).toEqual(["get_weather", "broken"]);
    expect(out.done!.result.toolCalls[1].valid).toBe(false);
    expect(seen).toHaveLength(1);
    expect(seen[0].headers.authorization).toBe("Bearer sk-live-SECRET-123");
    expect(seen[0].body).toMatchObject({ model: "test-model", stream: true });
    // What comes back to the browser never contains the key.
    expect(out.text).not.toContain("sk-live-SECRET-123");
  });

  it("streams an Anthropic answer and adds the version header only when the user has not", async () => {
    seen = [];
    const out = await run("/anthropic/stream", { provider: "anthropic" });
    expect(out.done!.result).toMatchObject({
      text: "Hi there",
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
    });
    expect(seen[0].headers["anthropic-version"]).toBe(ANTHROPIC_VERSION);
    seen = [];
    await run(
      "/anthropic/stream",
      { provider: "anthropic" },
      { headers: [{ key: "anthropic-version", value: "2024-01-01", enabled: true }] },
    );
    expect(seen[0].headers["anthropic-version"]).toBe("2024-01-01");
  });

  it("handles a non-streaming request", async () => {
    const out = await run("/json", { stream: false });
    expect(out.done!.result).toMatchObject({ text: "plain answer", usage: { totalTokens: 5 } });
  });

  it("handles a self-hosted server that ignores stream: true and answers with JSON", async () => {
    const out = await run("/json", { stream: true });
    expect(out.done!.result.text).toBe("plain answer");
  });

  it("reports provider errors and masks a credential the provider echoes back", async () => {
    for (const stream of [true, false]) {
      const out = await run("/unauthorized", { stream });
      const error = out.messages.find((m) => m.type === "error") as unknown as {
        status: number;
        message: string;
      };
      expect(error.status).toBe(401);
      expect(error.message).toContain("Incorrect API key provided");
      expect(out.text).not.toContain("sk-live-SECRET-123");
    }
  });

  it("does not send a second request on failure", async () => {
    seen = [];
    await run("/unauthorized", { stream: true });
    expect(seen).toHaveLength(1);
  });

  it("refuses requests that are not model requests or are invalid", async () => {
    const response = await aiRoute.POST(
      new Request("http://localhost/api/ai", {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          request: {
            name: "x",
            method: "GET",
            url: `${base}/json`,
            headers: [],
            params: [],
            body: { mode: "none" },
            auth: { type: "none" },
          },
        }),
      }),
    );
    expect(response.status).toBe(400);
    const missingModel = await run("/json", { model: "" });
    expect(missingModel.status).toBe(400);
    expect(missingModel.text).toMatch(/model/i);
  });

  it("requires a login", async () => {
    const response = await aiRoute.POST(
      new Request("http://localhost/api/ai", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(response.status).toBe(401);
  });
});
