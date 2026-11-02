"use client";
/** Model request body: provider, model, parameters, conversation and tool definitions. */
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { DEFAULT_AI_CONFIG, type AiConfig, type AiMessage, type AiTool } from "@/core/ai/types";
import type { BodyConfig } from "@/core/types";

type AiBody = Extract<BodyConfig, { mode: "ai" }>;

const selectClass =
  "h-8 rounded-md border border-input bg-transparent px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";

export const emptyAiBody = (): AiBody => ({
  mode: "ai",
  ai: { ...DEFAULT_AI_CONFIG, messages: [{ role: "user", content: "" }] },
});

const number = (text: string): number | undefined => {
  if (!text.trim()) return undefined;
  const n = Number(text);
  return Number.isFinite(n) ? n : undefined;
};

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="font-medium">{label}</span>
      {children}
      {hint && <span className="text-muted-foreground">{hint}</span>}
    </label>
  );
}

export function AiBodyEditor({ body, onChange }: { body: AiBody; onChange: (b: BodyConfig) => void }) {
  const ai = body.ai;
  const set = (patch: Partial<AiConfig>) => onChange({ ...body, ai: { ...ai, ...patch } });
  const setMessage = (i: number, patch: Partial<AiMessage>) =>
    set({ messages: ai.messages.map((m, j) => (j === i ? { ...m, ...patch } : m)) });
  const setTool = (i: number, patch: Partial<AiTool>) =>
    set({ tools: ai.tools.map((t, j) => (j === i ? { ...t, ...patch } : t)) });

  return (
    <div className="space-y-4 p-3 text-sm">
      <p className="text-xs text-muted-foreground">
        Set the endpoint in the URL bar and the API key under Authorization (Bearer for OpenAI-compatible
        servers, an API key header named <code>x-api-key</code> for Anthropic). OpenAI-compatible covers
        OpenAI, Azure, Ollama (<code>http://localhost:11434/v1/chat/completions</code>), vLLM, LM Studio and
        other self-hosted servers.
      </p>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Provider format">
          <select
            className={selectClass}
            value={ai.provider}
            onChange={(e) => set({ provider: e.target.value as AiConfig["provider"] })}
          >
            <option value="openai">OpenAI-compatible (chat completions)</option>
            <option value="anthropic">Anthropic (messages)</option>
          </select>
        </Field>
        <Field label="Model">
          <Input
            value={ai.model}
            placeholder="e.g. a model name or {{model}}"
            onChange={(e) => set({ model: e.target.value })}
          />
        </Field>
        <Field label="Stream the answer">
          <Switch checked={ai.stream} onCheckedChange={(stream) => set({ stream })} aria-label="Stream" />
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Temperature" hint="0–2, blank for the default">
          <Input
            inputMode="decimal"
            value={ai.temperature ?? ""}
            onChange={(e) => set({ temperature: number(e.target.value) })}
          />
        </Field>
        <Field label="Top P" hint="0–1, blank for the default">
          <Input
            inputMode="decimal"
            value={ai.topP ?? ""}
            onChange={(e) => set({ topP: number(e.target.value) })}
          />
        </Field>
        <Field
          label="Max output tokens"
          hint={ai.provider === "anthropic" ? "Default 1024" : "Blank for the default"}
        >
          <Input
            inputMode="numeric"
            value={ai.maxTokens ?? ""}
            onChange={(e) => {
              const n = number(e.target.value);
              set({ maxTokens: n === undefined ? undefined : Math.max(1, Math.round(n)) });
            }}
          />
        </Field>
      </div>

      <Field label="System prompt">
        <Textarea
          className="min-h-16 font-mono text-xs"
          value={ai.system}
          onChange={(e) => set({ system: e.target.value })}
        />
      </Field>

      <section className="space-y-2" aria-label="Messages">
        <div className="flex items-center justify-between">
          <h4 className="text-xs font-medium">Conversation</h4>
          <Button
            size="sm"
            variant="outline"
            onClick={() => set({ messages: [...ai.messages, { role: "user", content: "" }] })}
          >
            <Plus className="size-3.5" /> Message
          </Button>
        </div>
        {ai.messages.map((m, i) => (
          <div key={i} className="space-y-1 rounded-md border p-2">
            <div className="flex items-center gap-2">
              <select
                className={selectClass}
                aria-label={`Role of message ${i + 1}`}
                value={m.role}
                onChange={(e) => setMessage(i, { role: e.target.value as AiMessage["role"] })}
              >
                <option value="user">user</option>
                <option value="assistant">assistant</option>
                <option value="tool">tool result</option>
              </select>
              {m.role === "tool" && (
                <Input
                  className="h-8 w-56 font-mono text-xs"
                  aria-label={`Tool call id of message ${i + 1}`}
                  placeholder="tool call id"
                  value={m.toolCallId ?? ""}
                  onChange={(e) => setMessage(i, { toolCallId: e.target.value })}
                />
              )}
              {m.toolCalls?.length ? (
                <span className="rounded border px-1 text-xs text-muted-foreground">
                  {m.toolCalls.length} tool call{m.toolCalls.length === 1 ? "" : "s"}
                </span>
              ) : null}
              <Button
                size="icon"
                variant="ghost"
                className="ml-auto size-7"
                title="Remove message"
                onClick={() => set({ messages: ai.messages.filter((_, j) => j !== i) })}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
            <Textarea
              className="min-h-16 font-mono text-xs"
              aria-label={`Content of message ${i + 1}`}
              value={m.content}
              onChange={(e) => setMessage(i, { content: e.target.value })}
            />
          </div>
        ))}
      </section>

      <section className="space-y-2" aria-label="Tools">
        <div className="flex items-center justify-between gap-2">
          <h4 className="text-xs font-medium">Tools the model may call</h4>
          <div className="flex items-center gap-2">
            {ai.tools.length > 0 && (
              <select
                className={selectClass}
                aria-label="Tool choice"
                value={ai.toolChoice}
                onChange={(e) => set({ toolChoice: e.target.value as AiConfig["toolChoice"] })}
              >
                <option value="auto">model decides</option>
                <option value="required">must call a tool</option>
                <option value="none">never call</option>
              </select>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                set({
                  tools: [
                    ...ai.tools,
                    {
                      name: "",
                      description: "",
                      parameters: '{\n  "type": "object",\n  "properties": {}\n}',
                    },
                  ],
                })
              }
            >
              <Plus className="size-3.5" /> Tool
            </Button>
          </div>
        </div>
        {ai.tools.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No tools. Postbox only reports the calls a model makes; it never runs a tool. You decide what
            result to send back.
          </p>
        ) : (
          ai.tools.map((t, i) => (
            <div key={i} className="space-y-1 rounded-md border p-2">
              <div className="flex gap-2">
                <Input
                  className="h-8 w-48 font-mono text-xs"
                  aria-label={`Name of tool ${i + 1}`}
                  placeholder="tool_name"
                  value={t.name}
                  onChange={(e) => setTool(i, { name: e.target.value })}
                />
                <Input
                  className="h-8 flex-1 text-xs"
                  aria-label={`Description of tool ${i + 1}`}
                  placeholder="What it does"
                  value={t.description}
                  onChange={(e) => setTool(i, { description: e.target.value })}
                />
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-8"
                  title="Remove tool"
                  onClick={() => set({ tools: ai.tools.filter((_, j) => j !== i) })}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
              <Textarea
                className="min-h-20 font-mono text-xs"
                aria-label={`Parameters of tool ${i + 1}`}
                value={t.parameters}
                onChange={(e) => setTool(i, { parameters: e.target.value })}
              />
            </div>
          ))
        )}
      </section>

      <Field
        label="Extra parameters (JSON)"
        hint="Merged into the request, for options a provider or self-hosted server adds (for example top_k)."
      >
        <Textarea
          className="min-h-14 font-mono text-xs"
          placeholder="{}"
          value={ai.extra}
          onChange={(e) => set({ extra: e.target.value })}
        />
      </Field>
    </div>
  );
}
