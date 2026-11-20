"use client";
/**
 * The assistant beside a request tab. Each turn sends the tab's current request (and, by default,
 * its last response) as context. The model proposes edits to this request, a send or a save; each
 * proposal shows a per-field diff and changes nothing until the person approves it.
 */
import { useEffect, useRef, useState } from "react";
import { Loader2, Undo2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { AiMessage } from "@/core/ai/types";
import { assistantProposal } from "@/core/assistant/model";
import {
  applyEdit,
  changedFields,
  editableSnapshot,
  FIELD_LABELS,
  parseRequestEdit,
  REQUEST_ASSISTANT_SYSTEM,
  REQUEST_ASSISTANT_TOOLS,
  requestContext,
  staleFields,
  type EditableField,
  type EditableRequest,
} from "@/core/assistant/request-edit";
import { diffLines, diffText } from "@/core/assistant/diff";
import { authCredentialValues, credentialRedactionValues, sensitiveFieldValues } from "@/core/retention";
import { DEFAULT_SETTINGS } from "@/core/types";
import { askAssistant } from "@/lib/assistant-client";
import { cn } from "@/lib/utils";
import { useApp, type RequestDraft, type Tab } from "@/stores/app";
import { useDialogs } from "@/stores/dialogs";
import {
  useAssistantSettings,
  useRequestAssistants,
  type AssistantProvider,
  type Proposal,
} from "@/stores/assistant";

type RequestTab = Extract<Tab, { type: "request" }>;
const SUPPORTED = ["propose_request_edit", "propose_send", "propose_save", "propose_request"];

/** Values that stay hidden from the model unless "Send secret values" is on. */
function secretValues(draft: RequestDraft): string[] {
  return credentialRedactionValues([
    ...authCredentialValues(draft.auth),
    ...sensitiveFieldValues(draft.body),
    ...Object.values(useApp.getState().variables)
      .filter((v) => v.secret)
      .map((v) => v.value),
  ]);
}

/** Tell the model what happened to its last proposals before the next user message. */
function outcomes(proposals: Proposal[], callIds: string[]): AiMessage[] {
  return callIds.map((id) => {
    const p = proposals.find((x) => x.callId === id);
    const text = !p
      ? "Not shown to the user."
      : p.status === "applied"
        ? p.name === "propose_request_edit"
          ? `Applied by the user (fields: ${(p.applied ?? []).join(", ")}). The current request below reflects it.`
          : `Approved and done by the user.${p.note ? ` ${p.note}` : ""}`
        : p.status === "rejected"
          ? "Rejected by the user. Nothing changed."
          : p.status === "undone"
            ? "Applied, then undone by the user. Nothing changed."
            : p.status === "failed"
              ? `Could not be applied: ${p.note ?? "invalid proposal"}.`
              : "Not reviewed yet. Nothing changed.";
    return { role: "tool", toolCallId: id, content: text };
  });
}

export function RequestAssistant({ tab, onClose }: { tab: RequestTab; onClose: () => void }) {
  const workspaceId = useApp((s) => s.workspaceId);
  const tabIds = useApp((s) => s.tabs.map((t) => t.id).join(","));
  const settings = useAssistantSettings();
  const conversation = useRequestAssistants((s) => s.get(tab.id));
  const update = useRequestAssistants((s) => s.update);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [streamed, setStreamed] = useState("");
  const [error, setError] = useState("");
  const [showContext, setShowContext] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  // Closing a tab clears its conversation.
  useEffect(() => useRequestAssistants.getState().prune(tabIds.split(",")), [tabIds]);

  const draft = tab.draft;
  const context = () =>
    requestContext(draft, {
      secrets: settings.includeSecrets ? [] : secretValues(draft),
      response: settings.includeResponse ? (tab.result?.response ?? null) : null,
      tests: settings.includeResponse ? tab.result?.tests : undefined,
      errors: settings.includeResponse
        ? [
            tab.result?.error,
            ...(tab.result?.scriptErrors ?? []).map((e) => `${e.phase} script: ${e.message}`),
          ].filter((e): e is string => !!e)
        : undefined,
      variables: Object.fromEntries(
        Object.entries(useApp.getState().variables).map(([name, v]) => [name, v.value]),
      ),
    });

  async function ask() {
    const text = prompt.trim();
    if (!text || busy || !workspaceId) return;
    const ctrl = new AbortController();
    controller.current = ctrl;
    setBusy(true);
    setError("");
    setStreamed("");
    try {
      const history = conversation.messages;
      const last = [...history].reverse().find((m) => m.role === "assistant");
      const answered = new Set(history.filter((m) => m.role === "tool").map((m) => m.toolCallId));
      const pendingCalls = (last?.toolCalls ?? []).map((c) => c.id).filter((id) => !answered.has(id));
      const messages: AiMessage[] = [
        ...history,
        ...outcomes(conversation.proposals, pendingCalls),
        { role: "user", content: `${context()}\n\n---\nUser: ${text}` },
      ];
      const snapshot = editableSnapshot(draft);
      const result = await askAssistant({
        workspaceId,
        ...settings,
        system: REQUEST_ASSISTANT_SYSTEM,
        tools: REQUEST_ASSISTANT_TOOLS,
        messages,
        includeSecrets: settings.includeSecrets,
        signal: ctrl.signal,
        onText: (t) => setStreamed((v) => v + t),
      });
      const calls = result.toolCalls.map((c) => ({ ...c, id: c.id || crypto.randomUUID() }));
      const userIndex = messages.length - 1;
      update(tab.id, (c) => ({
        ...c,
        messages: [...messages, { role: "assistant", content: result.text, toolCalls: calls }],
        shown: { ...c.shown, [userIndex]: text },
        proposals: [
          ...c.proposals,
          ...calls.map((call): Proposal => ({
            callId: call.id,
            name: call.name,
            arguments: call.arguments,
            valid: call.valid && SUPPORTED.includes(call.name),
            snapshot,
            status: "pending",
          })),
        ],
      }));
      setPrompt("");
    } catch (e) {
      setError(ctrl.signal.aborted ? "Stopped" : e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setStreamed("");
      controller.current = null;
    }
  }

  const setProposal = (callId: string, patch: Partial<Proposal>) =>
    update(tab.id, (c) => ({
      ...c,
      proposals: c.proposals.map((p) => (p.callId === callId ? { ...p, ...patch } : p)),
    }));

  return (
    <aside
      aria-label="Request assistant"
      className="flex h-full min-h-0 w-full flex-col border-l bg-background text-xs"
    >
      <header className="flex items-center gap-2 border-b px-3 py-2">
        <h2 className="text-sm font-medium">Assistant</h2>
        <span className="truncate text-muted-foreground">for this request</span>
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto size-6"
          title="Close assistant"
          onClick={onClose}
        >
          <X className="size-3.5" />
        </Button>
      </header>
      <ModelSettings />
      <div className="min-h-0 flex-1 space-y-2 overflow-auto p-3" aria-label="Assistant conversation">
        {conversation.messages.map((m, i) =>
          m.role === "tool" ? null : (
            <article
              key={i}
              className={cn("rounded border p-2", m.role === "user" ? "bg-muted/40" : "bg-background")}
            >
              <div className="mb-1 font-medium text-muted-foreground">
                {m.role === "user" ? "You" : "Assistant"}
              </div>
              <pre className="whitespace-pre-wrap break-words font-sans">
                {m.role === "user" ? (conversation.shown[i] ?? m.content) : m.content}
              </pre>
              {m.role === "assistant" &&
                (m.toolCalls ?? []).map((call) => {
                  const p = conversation.proposals.find((x) => x.callId === call.id);
                  return p ? (
                    <ProposalCard
                      key={call.id}
                      tab={tab}
                      proposal={p}
                      setProposal={setProposal}
                      busy={busy}
                    />
                  ) : null;
                })}
            </article>
          ),
        )}
        {busy && (
          <article className="rounded border p-2">
            <Loader2 className="inline size-3 animate-spin" />{" "}
            <pre className="inline whitespace-pre-wrap font-sans">{streamed || "Thinking…"}</pre>
          </article>
        )}
        {!conversation.messages.length && !busy && (
          <p className="text-muted-foreground">
            Ask about this request: change headers, auth, body, scripts, contract or settings, explain the
            last response, or fix a failing test. Every change is shown for your approval first.
          </p>
        )}
      </div>
      <div className="space-y-2 border-t p-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <label className="flex items-center gap-1.5">
            <Switch
              checked={settings.includeResponse}
              onCheckedChange={(v) => settings.set({ includeResponse: v })}
              aria-label="Include last response"
            />
            Include last response
          </label>
          <label className="flex items-center gap-1.5">
            <Switch
              checked={settings.includeSecrets}
              onCheckedChange={(v) => settings.set({ includeSecrets: v })}
              aria-label="Send secret values"
            />
            Send secret values
          </label>
          <button className="underline" onClick={() => setShowContext((v) => !v)}>
            {showContext ? "Hide" : "Show"} what is sent
          </button>
        </div>
        {settings.includeSecrets && (
          <p role="status" className="text-amber-700 dark:text-amber-400">
            Credentials and secret variable values are sent to the model. Use this with a local model.
          </p>
        )}
        {showContext && (
          <pre
            data-testid="assistant-context"
            className="max-h-48 overflow-auto rounded bg-muted/40 p-2 font-mono text-[11px] whitespace-pre-wrap break-all"
          >
            {context()}
          </pre>
        )}
        <Textarea
          value={prompt}
          disabled={busy}
          maxLength={30000}
          aria-label="Message to the assistant"
          placeholder="For example: add an Authorization header with {{token}} and a test that the status is 200"
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void ask();
          }}
        />
        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={busy || !prompt.trim() || !settings.server.trim() || !settings.model.trim()}
            onClick={() => void ask()}
          >
            Ask
          </Button>
          {busy && (
            <Button size="sm" variant="outline" onClick={() => controller.current?.abort()}>
              Stop
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !conversation.messages.length}
            onClick={() => update(tab.id, (c) => ({ ...c, messages: [], shown: {}, proposals: [] }))}
          >
            New conversation
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
      </div>
    </aside>
  );
}

function ModelSettings() {
  const s = useAssistantSettings();
  const [open, setOpen] = useState(!s.server || !s.model);
  return (
    <section aria-label="Assistant model settings" className="border-b px-3 py-2">
      <button className="text-muted-foreground underline" onClick={() => setOpen((v) => !v)}>
        {s.server && s.model ? `Model: ${s.model}` : "Set up the model"}
      </button>
      {open && (
        <div className="mt-2 grid grid-cols-2 gap-2">
          <label className="col-span-2">
            Provider
            <select
              className="block w-full rounded border bg-background p-1"
              value={s.provider}
              onChange={(e) => s.set({ provider: e.target.value as AssistantProvider })}
            >
              <option value="strata">Strata</option>
              <option value="ollama">Ollama</option>
              <option value="openai">OpenAI-compatible</option>
            </select>
          </label>
          <label className="col-span-2">
            Server URL
            <Input
              value={s.server}
              placeholder="http://your-server:11434"
              onChange={(e) => s.set({ server: e.target.value })}
            />
          </label>
          <label>
            Model
            <Input value={s.model} onChange={(e) => s.set({ model: e.target.value })} />
          </label>
          <label>
            API key (optional)
            <Input
              type="password"
              autoComplete="off"
              value={s.token}
              onChange={(e) => s.set({ token: e.target.value })}
            />
          </label>
          <p className="col-span-2 text-muted-foreground">
            Shared with the sidebar assistant for this session; never saved in the browser.
          </p>
        </div>
      )}
    </section>
  );
}

function ProposalCard({
  tab,
  proposal,
  setProposal,
  busy,
}: {
  tab: RequestTab;
  proposal: Proposal;
  setProposal: (callId: string, patch: Partial<Proposal>) => void;
  busy: boolean;
}) {
  const updateDraft = useApp((s) => s.updateDraft);
  const [confirmStale, setConfirmStale] = useState(false);
  const pending = proposal.status === "pending";
  const parsed = (() => {
    if (proposal.name !== "propose_request_edit") return null;
    try {
      return parseRequestEdit(proposal.arguments);
    } catch (e) {
      return e instanceof Error ? e : new Error(String(e));
    }
  })();
  const edit = parsed instanceof Error ? null : parsed;
  const changes = edit ? changedFields(proposal.snapshot, edit.changes) : [];
  const [selected, setSelected] = useState<EditableField[]>(() => changes.map((c) => c.field));
  const current = editableSnapshot(tab.draft as EditableRequest);
  const stale = edit && pending ? staleFields(proposal.snapshot, current, selected) : [];

  const fail = (note: string) => setProposal(proposal.callId, { status: "failed", note });
  function apply(fields: EditableField[]) {
    if (!edit) return;
    if (stale.length && !confirmStale) {
      setConfirmStale(true);
      return;
    }
    const before = editableSnapshot(tab.draft as EditableRequest);
    const next = applyEdit(tab.draft, edit.changes, fields);
    const patch = Object.fromEntries(fields.map((f) => [f, next[f]])) as Partial<RequestDraft>;
    updateDraft(tab.id, patch);
    setProposal(proposal.callId, {
      status: "applied",
      applied: fields,
      undo: Object.fromEntries(fields.map((f) => [f, before[f]])),
    });
  }
  async function act() {
    const app = useApp.getState();
    if (proposal.name === "propose_send") {
      setProposal(proposal.callId, { status: "applied" });
      await app.sendTab(tab.id);
      const after = useApp.getState().tabs.find((t) => t.id === tab.id);
      const r = after?.type === "request" ? after.result : null;
      setProposal(proposal.callId, {
        status: "applied",
        note: r?.response ? `Response ${r.response.status}; it is in the next context.` : (r?.error ?? ""),
      });
    } else if (proposal.name === "propose_save") {
      if (tab.requestId) {
        const ok = await app.saveTab(tab.id);
        if (ok) setProposal(proposal.callId, { status: "applied" });
        else fail("saving failed");
      } else {
        useDialogs.getState().openSave(tab.id);
        setProposal(proposal.callId, { status: "applied", note: "The user was asked where to save it." });
      }
    } else if (proposal.name === "propose_request") {
      try {
        const p = assistantProposal.parse(JSON.parse(proposal.arguments));
        app.openDraft({
          id: crypto.randomUUID(),
          name: p.name,
          method: p.method,
          url: p.url,
          description: p.description,
          params: [],
          headers: [],
          auth: { type: "none" },
          body: p.body ? { mode: "raw", raw: p.body, language: "text" } : { mode: "none" },
          preRequestScript: "",
          testScript: p.testScript,
          settings: { ...DEFAULT_SETTINGS },
          folderId: null,
        });
        setProposal(proposal.callId, { status: "applied", note: "Opened as a new draft tab." });
      } catch (e) {
        fail(e instanceof Error ? e.message : "invalid proposal");
      }
    }
  }

  const title =
    proposal.name === "propose_request_edit"
      ? "Proposed changes to this request"
      : proposal.name === "propose_send"
        ? "Proposed: send this request"
        : proposal.name === "propose_save"
          ? "Proposed: save this request"
          : proposal.name === "propose_request"
            ? "Proposed: new request draft"
            : `Unsupported action: ${proposal.name}`;
  const statusLabel = {
    pending: "",
    applied: proposal.name === "propose_request_edit" ? "Applied" : "Done",
    rejected: "Rejected",
    undone: "Undone",
    failed: "Failed",
  }[proposal.status];

  return (
    <section aria-label={title} className="mt-2 space-y-2 rounded border border-primary/40 p-2">
      <div className="flex items-center gap-2">
        <h3 className="font-medium">{title}</h3>
        {statusLabel && <span className="ml-auto rounded bg-muted px-1.5 py-0.5">{statusLabel}</span>}
      </div>
      {edit?.summary && <p>{edit.summary}</p>}
      {parsed instanceof Error && (
        <p className="text-destructive">This proposal is not valid: {parsed.message}</p>
      )}
      {!proposal.valid && <p className="text-destructive">This action cannot be approved.</p>}
      {proposal.name === "propose_request" && (
        <pre className="whitespace-pre-wrap break-all">{proposal.arguments}</pre>
      )}
      {edit && changes.length === 0 && (
        <p className="text-muted-foreground">No differences from the request.</p>
      )}
      {changes.map((c) => (
        <div key={c.field} className="rounded border">
          <label className="flex items-center gap-2 border-b bg-muted/40 px-2 py-1 font-medium">
            {pending && (
              <Checkbox
                checked={selected.includes(c.field)}
                aria-label={`Apply ${FIELD_LABELS[c.field]}`}
                onCheckedChange={(v) =>
                  setSelected((s) => (v ? [...s, c.field] : s.filter((f) => f !== c.field)))
                }
              />
            )}
            {FIELD_LABELS[c.field]}
            {stale.includes(c.field) && (
              <span className="text-amber-700 dark:text-amber-400">changed since this was proposed</span>
            )}
          </label>
          <pre className="max-h-64 overflow-auto p-1 font-mono text-[11px]" data-field={c.field}>
            {diffLines(diffText(c.before), diffText(c.after)).map((l, i) => (
              <div
                key={i}
                className={cn(
                  "whitespace-pre-wrap break-all",
                  l.kind === "add" && "bg-green-500/15 text-green-800 dark:text-green-300",
                  l.kind === "remove" && "bg-red-500/15 text-red-800 line-through dark:text-red-300",
                )}
              >
                {l.kind === "add" ? "+ " : l.kind === "remove" ? "- " : "  "}
                {l.text}
              </div>
            ))}
          </pre>
        </div>
      ))}
      {confirmStale && stale.length > 0 && pending && (
        <p role="alert" className="text-amber-700 dark:text-amber-400">
          You changed {stale.map((f) => FIELD_LABELS[f]).join(", ")} after this was proposed. Applying
          replaces your changes. Apply again to confirm.
        </p>
      )}
      {proposal.note && <p className="text-muted-foreground">{proposal.note}</p>}
      {pending && proposal.valid && !(parsed instanceof Error) && (
        <div className="flex flex-wrap gap-2">
          {proposal.name === "propose_request_edit" ? (
            <>
              <Button
                size="sm"
                disabled={busy || !changes.length}
                onClick={() => apply(changes.map((c) => c.field))}
              >
                Apply
              </Button>
              {changes.length > 1 && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || !selected.length || selected.length === changes.length}
                  onClick={() => apply(selected)}
                >
                  Apply selected
                </Button>
              )}
            </>
          ) : (
            <Button size="sm" disabled={busy} onClick={() => void act()}>
              {proposal.name === "propose_send"
                ? "Send"
                : proposal.name === "propose_save"
                  ? "Save"
                  : "Open draft"}
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => setProposal(proposal.callId, { status: "rejected" })}
          >
            Reject
          </Button>
        </div>
      )}
      {proposal.status === "applied" && proposal.undo && (
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            updateDraft(tab.id, proposal.undo as Partial<RequestDraft>);
            setProposal(proposal.callId, { status: "undone" });
          }}
        >
          <Undo2 className="size-3.5" /> Undo
        </Button>
      )}
    </section>
  );
}
