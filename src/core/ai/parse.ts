/**
 * Provider responses → normalised events. Streaming decoders take server-sent events as they arrive
 * and tolerate any chunking, unknown event types and malformed JSON; nothing here throws on hostile input.
 */
import type { AiEvent, AiProvider, AiResult, AiResultToolCall, AiToolCall, AiUsage } from "./types";

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : undefined;
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function parse(text: string): Json | undefined {
  try {
    return obj(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/** The provider's error message from an error body (`{error:{message}}`, `{error:"…"}` or plain text). */
export function errorMessage(body: string): string {
  const json = parse(body);
  const error = json?.error;
  const message = str(obj(error)?.message) ?? str(error) ?? str(json?.message);
  return (message ?? body).trim().slice(0, 1000) || "The provider returned an error";
}

function openaiUsage(usage: Json | undefined): AiUsage | undefined {
  if (!usage) return undefined;
  const out: AiUsage = {
    inputTokens: num(usage.prompt_tokens),
    outputTokens: num(usage.completion_tokens),
    totalTokens: num(usage.total_tokens),
  };
  return out.inputTokens === undefined && out.outputTokens === undefined && out.totalTokens === undefined
    ? undefined
    : out;
}

function anthropicUsage(usage: Json | undefined, previous: AiUsage = {}): AiUsage | undefined {
  if (!usage) return undefined;
  const inputTokens = num(usage.input_tokens) ?? previous.inputTokens;
  const outputTokens = num(usage.output_tokens) ?? previous.outputTokens;
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  return {
    inputTokens,
    outputTokens,
    totalTokens:
      inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined,
  };
}

export interface StreamDecoder {
  /** Decode one server-sent event. `event` is the SSE event name (may be empty or "message"). */
  feed(event: string, data: string): AiEvent[];
}

export function createDecoder(provider: AiProvider): StreamDecoder {
  return provider === "anthropic" ? anthropicDecoder() : openaiDecoder();
}

function openaiDecoder(): StreamDecoder {
  return {
    feed(_event, data) {
      if (data.trim() === "[DONE]") return [];
      const json = parse(data);
      if (!json) return [];
      if (json.error) return [{ type: "error", message: errorMessage(data) }];
      const events: AiEvent[] = [];
      const model = str(json.model);
      if (model) events.push({ type: "meta", model });
      for (const choice of Array.isArray(json.choices) ? json.choices : []) {
        const c = obj(choice);
        const delta = obj(c?.delta);
        const text = str(delta?.content);
        if (text) events.push({ type: "text", text });
        const reasoning = str(delta?.reasoning_content) ?? str(delta?.reasoning);
        if (reasoning) events.push({ type: "reasoning", text: reasoning });
        for (const call of Array.isArray(delta?.tool_calls) ? (delta.tool_calls as unknown[]) : []) {
          const t = obj(call);
          const fn = obj(t?.function);
          events.push({
            type: "tool_call",
            index: num(t?.index) ?? 0,
            id: str(t?.id),
            name: str(fn?.name),
            argumentsDelta: str(fn?.arguments) ?? "",
          });
        }
        const finish = str(c?.finish_reason);
        if (finish) events.push({ type: "finish", reason: finish });
      }
      const usage = openaiUsage(obj(json.usage));
      if (usage) events.push({ type: "usage", usage });
      return events;
    },
  };
}

function anthropicDecoder(): StreamDecoder {
  let usage: AiUsage = {};
  // Block index → what it is, so deltas know whether they are text or tool arguments.
  const blocks = new Map<number, "text" | "thinking" | "tool">();
  const toolOrder: number[] = [];
  return {
    feed(event, data) {
      const json = parse(data);
      if (!json) return [];
      const type = str(json.type) ?? event;
      const events: AiEvent[] = [];
      switch (type) {
        case "message_start": {
          const message = obj(json.message);
          const model = str(message?.model);
          if (model) events.push({ type: "meta", model });
          const next = anthropicUsage(obj(message?.usage));
          if (next) {
            usage = next;
            events.push({ type: "usage", usage });
          }
          break;
        }
        case "content_block_start": {
          const index = num(json.index) ?? 0;
          const block = obj(json.content_block);
          const kind = str(block?.type);
          if (kind === "tool_use") {
            blocks.set(index, "tool");
            toolOrder.push(index);
            events.push({
              type: "tool_call",
              index: toolOrder.length - 1,
              id: str(block?.id),
              name: str(block?.name),
              argumentsDelta: "",
            });
          } else if (kind === "thinking") blocks.set(index, "thinking");
          else {
            blocks.set(index, "text");
            const text = str(block?.text);
            if (text) events.push({ type: "text", text });
          }
          break;
        }
        case "content_block_delta": {
          const index = num(json.index) ?? 0;
          const delta = obj(json.delta);
          const kind = str(delta?.type);
          if (kind === "text_delta" && str(delta?.text))
            events.push({ type: "text", text: str(delta?.text)! });
          else if (kind === "thinking_delta" && str(delta?.thinking))
            events.push({ type: "reasoning", text: str(delta?.thinking)! });
          else if (kind === "input_json_delta" && blocks.get(index) === "tool")
            events.push({
              type: "tool_call",
              index: toolOrder.indexOf(index),
              argumentsDelta: str(delta?.partial_json) ?? "",
            });
          break;
        }
        case "message_delta": {
          const reason = str(obj(json.delta)?.stop_reason);
          if (reason) events.push({ type: "finish", reason });
          const next = anthropicUsage(obj(json.usage), usage);
          if (next) {
            usage = next;
            events.push({ type: "usage", usage });
          }
          break;
        }
        case "error":
          events.push({ type: "error", message: errorMessage(data) });
          break;
        default:
          break;
      }
      return events;
    },
  };
}

/** Builds a result from events as they arrive. */
export class AiAccumulator {
  private text = "";
  private reasoning = "";
  private calls: { id: string; name: string; arguments: string }[] = [];
  private usage: AiUsage = {};
  private finishReason: string | null = null;
  private model: string | null = null;
  private error: string | null = null;

  add(event: AiEvent) {
    switch (event.type) {
      case "text":
        this.text += event.text;
        break;
      case "reasoning":
        this.reasoning += event.text;
        break;
      case "tool_call": {
        // Bound the index so a hostile stream cannot allocate a huge array.
        const index = Math.min(Math.max(event.index, 0), 63);
        while (this.calls.length <= index) this.calls.push({ id: "", name: "", arguments: "" });
        const call = this.calls[index];
        if (event.id) call.id = event.id;
        if (event.name) call.name = event.name;
        call.arguments += event.argumentsDelta;
        break;
      }
      case "usage":
        this.usage = { ...this.usage, ...event.usage };
        break;
      case "finish":
        this.finishReason = event.reason;
        break;
      case "meta":
        this.model = event.model;
        break;
      case "error":
        this.error = event.message;
        break;
    }
  }

  result(): AiResult {
    const toolCalls: AiResultToolCall[] = this.calls
      .filter((c) => c.name || c.arguments || c.id)
      .map((c) => ({ ...c, valid: isJsonObject(c.arguments) }));
    return {
      text: this.text,
      reasoning: this.reasoning,
      toolCalls,
      usage: this.usage,
      finishReason: this.finishReason,
      model: this.model,
      error: this.error,
    };
  }
}

function isJsonObject(text: string): boolean {
  if (!text.trim()) return true; // a tool with no parameters
  return parse(text) !== undefined;
}

/** A complete (non-streaming) response body. */
export function parseResponse(provider: AiProvider, body: string): AiResult {
  const accumulator = new AiAccumulator();
  const json = parse(body);
  if (!json) {
    accumulator.add({ type: "error", message: "The response was not JSON" });
    return accumulator.result();
  }
  if (json.error) {
    accumulator.add({ type: "error", message: errorMessage(body) });
    return accumulator.result();
  }
  const model = str(json.model);
  if (model) accumulator.add({ type: "meta", model });
  if (provider === "anthropic") {
    let toolIndex = 0;
    for (const block of Array.isArray(json.content) ? json.content : []) {
      const b = obj(block);
      const kind = str(b?.type);
      if (kind === "text" && str(b?.text)) accumulator.add({ type: "text", text: str(b?.text)! });
      else if (kind === "thinking" && str(b?.thinking))
        accumulator.add({ type: "reasoning", text: str(b?.thinking)! });
      else if (kind === "tool_use")
        accumulator.add({
          type: "tool_call",
          index: toolIndex++,
          id: str(b?.id),
          name: str(b?.name),
          argumentsDelta: JSON.stringify(b?.input ?? {}),
        });
    }
    const reason = str(json.stop_reason);
    if (reason) accumulator.add({ type: "finish", reason });
    const usage = anthropicUsage(obj(json.usage));
    if (usage) accumulator.add({ type: "usage", usage });
  } else {
    const message = obj(obj((Array.isArray(json.choices) ? json.choices : [])[0])?.message);
    const content = str(message?.content);
    if (content) accumulator.add({ type: "text", text: content });
    const reasoning = str(message?.reasoning_content) ?? str(message?.reasoning);
    if (reasoning) accumulator.add({ type: "reasoning", text: reasoning });
    (Array.isArray(message?.tool_calls) ? (message.tool_calls as unknown[]) : []).forEach((call, i) => {
      const fn = obj(obj(call)?.function);
      accumulator.add({
        type: "tool_call",
        index: i,
        id: str(obj(call)?.id),
        name: str(fn?.name),
        argumentsDelta: str(fn?.arguments) ?? "",
      });
    });
    const reason = str(obj((Array.isArray(json.choices) ? json.choices : [])[0])?.finish_reason);
    if (reason) accumulator.add({ type: "finish", reason });
    const usage = openaiUsage(obj(json.usage));
    if (usage) accumulator.add({ type: "usage", usage });
  }
  return accumulator.result();
}

export type { AiToolCall };
