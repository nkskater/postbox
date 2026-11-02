/** Turn a saved AI configuration into the provider's JSON request body. */
import type { AiConfig, AiMessage } from "./types";
import { RESERVED_EXTRA_KEYS } from "./types";

export const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_ANTHROPIC_MAX_TOKENS = 1024;

function parseJsonObject(text: string, what: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${what} is not valid JSON`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${what} must be a JSON object`);
  return value as Record<string, unknown>;
}

function toolSchema(parameters: string, name: string) {
  return parameters.trim()
    ? parseJsonObject(parameters, `Parameters of tool "${name}"`)
    : { type: "object", properties: {} };
}

/** Arguments the model produced; a malformed string is passed on as text so it can be inspected. */
function inputOf(args: string): unknown {
  if (!args.trim()) return {};
  try {
    return JSON.parse(args);
  } catch {
    return { _raw: args };
  }
}

function validate(config: AiConfig) {
  if (!config.model.trim()) throw new Error("Choose a model");
  if (!config.messages.length) throw new Error("Add at least one message");
  for (const tool of config.tools)
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(tool.name))
      throw new Error(`Tool name "${tool.name}" must be 1–64 letters, digits, _ or -`);
}

function extraParams(config: AiConfig): Record<string, unknown> {
  if (!config.extra.trim()) return {};
  const extra = parseJsonObject(config.extra, "Extra parameters");
  for (const key of RESERVED_EXTRA_KEYS)
    if (key in extra) throw new Error(`Extra parameters cannot set "${key}"; use the fields above`);
  return extra;
}

function openai(config: AiConfig): Record<string, unknown> {
  const messages: unknown[] = [];
  if (config.system.trim()) messages.push({ role: "system", content: config.system });
  for (const m of config.messages) {
    if (m.role === "tool") {
      messages.push({ role: "tool", tool_call_id: m.toolCallId ?? "", content: m.content });
    } else if (m.role === "assistant" && m.toolCalls?.length) {
      messages.push({
        role: "assistant",
        content: m.content || null,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: c.arguments },
        })),
      });
    } else messages.push({ role: m.role, content: m.content });
  }
  const payload: Record<string, unknown> = { model: config.model, messages, stream: config.stream };
  if (config.stream) payload.stream_options = { include_usage: true };
  if (config.temperature !== undefined) payload.temperature = config.temperature;
  if (config.topP !== undefined) payload.top_p = config.topP;
  if (config.maxTokens !== undefined) payload.max_tokens = config.maxTokens;
  if (config.tools.length) {
    payload.tools = config.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: toolSchema(t.parameters, t.name) },
    }));
    payload.tool_choice = config.toolChoice;
  }
  return payload;
}

function anthropicMessages(messages: AiMessage[]): unknown[] {
  const out: { role: string; content: unknown[] | string }[] = [];
  for (const m of messages) {
    if (m.role === "tool") {
      const block = { type: "tool_result", tool_use_id: m.toolCallId ?? "", content: m.content };
      const last = out[out.length - 1];
      // Results for parallel tool calls share one user turn.
      if (last && last.role === "user" && Array.isArray(last.content) && last.content.every(isToolResult))
        last.content.push(block);
      else out.push({ role: "user", content: [block] });
    } else if (m.role === "assistant" && m.toolCalls?.length) {
      out.push({
        role: "assistant",
        content: [
          ...(m.content ? [{ type: "text", text: m.content }] : []),
          ...m.toolCalls.map((c) => ({
            type: "tool_use",
            id: c.id,
            name: c.name,
            input: inputOf(c.arguments),
          })),
        ],
      });
    } else out.push({ role: m.role, content: m.content });
  }
  return out;
}
const isToolResult = (block: unknown) =>
  !!block && typeof block === "object" && (block as { type?: string }).type === "tool_result";

function anthropic(config: AiConfig): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    model: config.model,
    max_tokens: config.maxTokens ?? DEFAULT_ANTHROPIC_MAX_TOKENS,
    messages: anthropicMessages(config.messages),
    stream: config.stream,
  };
  if (config.system.trim()) payload.system = config.system;
  if (config.temperature !== undefined) payload.temperature = config.temperature;
  if (config.topP !== undefined) payload.top_p = config.topP;
  if (config.tools.length) {
    payload.tools = config.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: toolSchema(t.parameters, t.name),
    }));
    payload.tool_choice = { type: config.toolChoice === "required" ? "any" : config.toolChoice };
  }
  return payload;
}

/** The JSON body for this configuration. Throws a readable message when it is incomplete or invalid. */
export function buildAiPayload(config: AiConfig): Record<string, unknown> {
  validate(config);
  const base = config.provider === "anthropic" ? anthropic(config) : openai(config);
  return { ...extraParams(config), ...base };
}

/** Headers a provider needs beyond credentials; the caller adds them unless the user set their own. */
export function providerHeaders(provider: AiConfig["provider"]): [string, string][] {
  return provider === "anthropic" ? [["anthropic-version", ANTHROPIC_VERSION]] : [];
}
