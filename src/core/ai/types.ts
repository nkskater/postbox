/** AI model requests: the saved configuration and the normalised events every provider is turned into. */

export const AI_PROVIDERS = ["openai", "anthropic"] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

export interface AiToolCall {
  id: string;
  name: string;
  /** The arguments exactly as the model produced them (a JSON string, possibly malformed). */
  arguments: string;
}

export interface AiMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  /** Tool calls an assistant message made (needed to continue a conversation after a tool result). */
  toolCalls?: AiToolCall[];
  /** For role "tool": the call this result answers. */
  toolCallId?: string;
}

export interface AiTool {
  name: string;
  description: string;
  /** JSON Schema of the arguments, as JSON text. */
  parameters: string;
}

export interface AiConfig {
  provider: AiProvider;
  model: string;
  system: string;
  messages: AiMessage[];
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stream: boolean;
  tools: AiTool[];
  toolChoice: "auto" | "none" | "required";
  /** JSON object of extra provider parameters merged into the payload (for self-hosted servers). */
  extra: string;
}

export interface AiUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

/** What the decoders emit, whatever the provider. */
export type AiEvent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_call"; index: number; id?: string; name?: string; argumentsDelta: string }
  | { type: "usage"; usage: AiUsage }
  | { type: "finish"; reason: string }
  | { type: "meta"; model: string }
  | { type: "error"; message: string };

export interface AiResultToolCall extends AiToolCall {
  /** True when the arguments parse as a JSON object. */
  valid: boolean;
}

export interface AiResult {
  text: string;
  reasoning: string;
  toolCalls: AiResultToolCall[];
  usage: AiUsage;
  finishReason: string | null;
  model: string | null;
  error: string | null;
}

export const DEFAULT_AI_CONFIG: AiConfig = {
  provider: "openai",
  model: "",
  system: "",
  messages: [{ role: "user", content: "" }],
  stream: true,
  tools: [],
  toolChoice: "auto",
  extra: "",
};

/** Parameters the request builder sets itself, so the free-form `extra` cannot override them. */
export const RESERVED_EXTRA_KEYS = ["model", "messages", "stream", "tools", "tool_choice", "system"];
