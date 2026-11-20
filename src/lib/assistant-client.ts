/** One assistant model turn through POST /api/ai (assistant mode), streamed as NDJSON. */
import { DEFAULT_AI_CONFIG, type AiMessage, type AiResult, type AiTool } from "@/core/ai/types";
import { assistantEndpoint } from "@/core/assistant/model";
import { DEFAULT_SETTINGS, type RequestDef } from "@/core/types";
import { readNdjson } from "@/lib/ndjson";
import type { AssistantProvider } from "@/stores/assistant";

export interface AssistantTurn {
  workspaceId: string;
  provider: AssistantProvider;
  server: string;
  model: string;
  token: string;
  system: string;
  tools: AiTool[];
  messages: AiMessage[];
  includeSecrets?: boolean;
  signal?: AbortSignal;
  onText?: (text: string) => void;
}

export const MAX_CONVERSATION = 40;

export async function askAssistant(turn: AssistantTurn): Promise<AiResult> {
  if (turn.messages.length > MAX_CONVERSATION)
    throw Error(`Start a new conversation after ${MAX_CONVERSATION} messages`);
  const request: RequestDef = {
    id: crypto.randomUUID(),
    name: "Assistant model request",
    method: "POST",
    url: assistantEndpoint(turn.server),
    description: "",
    params: [],
    headers: [],
    auth: turn.token ? { type: "bearer", bearer: { token: turn.token } } : { type: "none" },
    body: {
      mode: "ai",
      ai: {
        ...DEFAULT_AI_CONFIG,
        provider: turn.provider,
        model: turn.model,
        system: turn.system,
        messages: turn.messages,
        tools: turn.tools,
        maxTokens: 4096,
      },
    },
    preRequestScript: "",
    testScript: "",
    settings: { ...DEFAULT_SETTINGS },
  };
  const res = await fetch("/api/ai", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspaceId: turn.workspaceId,
      request,
      assistant: true,
      includeSecrets: !!turn.includeSecrets,
    }),
    signal: turn.signal,
  });
  if (!res.ok || !res.body) throw Error((await res.json()).error ?? "Model request failed");
  let result: AiResult | null = null;
  for await (const raw of readNdjson(res.body)) {
    const event = raw as { type: string; text?: string; message?: string; result?: AiResult };
    if (event.type === "text") turn.onText?.(event.text ?? "");
    if (event.type === "error") throw Error(event.message ?? "Model request failed");
    if (event.type === "done") result = event.result ?? null;
  }
  if (!result) throw Error("The model stream ended without a complete result");
  if (result.error) throw Error(result.error);
  return result;
}
