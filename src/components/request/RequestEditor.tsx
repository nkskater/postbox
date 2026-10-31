"use client";
/**
 * Request tab: name/breadcrumb, method + URL bar, configuration tabs and the
 * response panel in a resizable vertical split.
 */
import { useCallback, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { ChevronRight, Code2, Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import { HTTP_METHODS, type KeyValue, type RequestDef } from "@/core/types";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { VarInput } from "@/components/editor/VarInput";
import { ResponseViewer } from "@/components/response/ResponseViewer";
import { EventStreamPanel } from "@/components/response/EventStreamPanel";
import { WebSocketPanel } from "@/components/response/WebSocketPanel";
import { folderPath, useApp, type RequestDraft, type Tab } from "@/stores/app";
import { useDialogs } from "@/stores/dialogs";
import { useSetting } from "@/stores/settings";
import { getSetting } from "@/lib/settings/runtime";
import { paramsFromUrl, urlWithParams } from "@/lib/url-params";
import { methodColor } from "@/lib/format";
import { api } from "@/lib/api";
import { parseCurl } from "@/core/convert/curl";
import { KeyValueEditor } from "./KeyValueEditor";
import { BodyEditor } from "./BodyEditor";
import { AuthEditor } from "./AuthEditor";
import { ScriptEditor } from "./ScriptEditor";
import { SettingsEditor } from "./SettingsEditor";
import { cn } from "@/lib/utils";
import {
  authCredentialValues,
  credentialRedactionValues,
  hasMissingUpload,
  redactSensitiveFields,
  sensitiveFieldValues,
} from "@/core/retention";
import { redactStoredValue } from "@/core/variables/resolver";

type RequestTab = Extract<Tab, { type: "request" }>;

const count = (list: KeyValue[]) => list.filter((x) => x.enabled && x.key).length;

function TabLabel({ label, n, dot }: { label: string; n?: number; dot?: boolean }) {
  return (
    <span className="flex items-center gap-1">
      {label}
      {!!n && <span className="text-[10px] text-success">({n})</span>}
      {dot && <span className="size-1.5 rounded-full bg-success" />}
    </span>
  );
}

export function RequestEditor({ tab }: { tab: RequestTab }) {
  const updateDraft = useApp((s) => s.updateDraft);
  const sendTab = useApp((s) => s.sendTab);
  const cancelSend = useApp((s) => s.cancelSend);
  const saveTab = useApp((s) => s.saveTab);
  const folders = useApp((s) => s.folders);
  const openSave = useDialogs((s) => s.openSave);
  const openCode = useDialogs((s) => s.openCode);
  const d = tab.draft;
  const sideBySide = useSetting<string>("layout.requestLayout") === "side-by-side";
  const set = useCallback(
    (patch: Partial<RequestDraft>) => updateDraft(tab.id, patch),
    [tab.id, updateDraft],
  );

  const save = () => (tab.requestId ? saveTab(tab.id) : openSave(tab.id));
  const isWebSocket = /^wss?:\/\//i.test(d.url.trim());
  const [streamKey, setStreamKey] = useState<number | null>(null);
  const [wsKey, setWsKey] = useState<number | null>(null);
  const send = () => {
    setStreamKey(null);
    if (isWebSocket) return setWsKey(Date.now());
    setWsKey(null);
    return sendTab(tab.id);
  };
  const crumbs = folderPath(folders, d.folderId);

  const onUrlChange = (url: string) => set({ url, params: paramsFromUrl(url, d.params) });
  const onParamsChange = (params: KeyValue[]) => set({ params, url: urlWithParams(d.url, params) });

  // Pasting a cURL command into the URL bar imports it.
  const onPaste = (text: string) => {
    if (!getSetting<boolean>("requests.curlPaste")) return false;
    if (!/^\s*curl\s/i.test(text)) return false;
    try {
      const r = parseCurl(text);
      set({
        method: r.method,
        url: r.url,
        params: paramsFromUrl(r.url),
        headers: r.headers,
        body: r.body,
        auth: r.auth,
      });
      toast.success("Imported cURL command");
      return true;
    } catch (err) {
      toast.error(`Could not parse cURL: ${(err as Error).message}`);
      return false;
    }
  };

  const saveExample = async () => {
    const res = tab.result?.response;
    if (!res) return;
    if (!tab.requestId) {
      toast.error("Save the request first");
      return;
    }
    const sent = tab.result?.sent;
    const sensitiveHeaderValues = (sent?.headers ?? [])
      .filter(([key]) => /authorization|cookie|token|password|secret|api[-_]?key|credential/i.test(key))
      .map(([, value]) => value);
    let sensitiveQueryValues: string[] = [];
    if (sent?.url) {
      try {
        sensitiveQueryValues = [...new URL(sent.url).searchParams.entries()]
          .filter(([key]) => /authorization|cookie|token|password|secret|api[-_]?key|credential/i.test(key))
          .map(([, value]) => value);
      } catch {
        // Invalid URLs are already reported by the request result.
      }
    }
    const secrets = credentialRedactionValues([
      ...authCredentialValues(d.auth),
      ...sensitiveHeaderValues,
      ...sensitiveQueryValues,
      ...sensitiveFieldValues(d.body),
      ...Object.values(useApp.getState().variables)
        .filter((variable) => variable.secret)
        .map((variable) => variable.value),
    ]);
    const example = redactStoredValue(
      redactSensitiveFields({
        id: Math.random().toString(36).slice(2),
        name: `${res.status} ${res.statusText}`,
        status: res.status,
        statusText: res.statusText,
        headers: res.headers.map(([key, value]) => ({ key, value, enabled: true })),
        body: res.bodyText,
        createdAt: Date.now(),
      }),
      secrets,
    );
    const examples = [...(d.examples ?? []), example];
    await api.requests.update(tab.requestId, { examples });
    set({ examples });
    toast.success("Saved as example");
  };

  const dirty =
    tab.saved !== null && tab.saved !== JSON.stringify((({ id: _i, examples: _e, ...r }) => r)(d));

  return (
    <div className="flex h-full min-h-0 flex-col">
      {(tab.credentialsOmitted || hasMissingUpload(d.body)) && (
        <div role="status" className="border-b bg-muted/40 px-3 py-1.5 text-[11px] text-muted-foreground">
          {tab.credentialsOmitted &&
            (tab.requestId
              ? "Restoring saved credentials from the workspace database…"
              : "Unsaved credentials were not retained in browser storage. Re-enter them before saving.")}
          {tab.credentialsOmitted && hasMissingUpload(d.body) ? " " : ""}
          {hasMissingUpload(d.body) &&
            "Restoring saved upload bytes… If this remains, reselect the file before saving or sending."}
        </div>
      )}
      {/* Breadcrumb / name / actions */}
      <div className="flex items-center gap-2 px-3 pt-2 pb-1 text-xs">
        <div className="flex min-w-0 items-center gap-1 text-muted-foreground">
          {crumbs.map((c) => (
            <span key={c.id} className="flex items-center gap-1">
              <span className="truncate">{c.name}</span>
              <ChevronRight className="size-3" />
            </span>
          ))}
          <input
            className="min-w-24 rounded bg-transparent px-1 py-0.5 text-sm font-medium text-foreground outline-none hover:bg-accent focus:bg-accent"
            value={d.name}
            onChange={(e) => set({ name: e.target.value })}
            size={Math.max(10, d.name.length)}
          />
        </div>
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            onClick={() => openCode(tab.id)}
            title="Code snippet"
          >
            <Code2 className="size-3.5" /> Code
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className={cn("h-7 text-xs", dirty && "text-primary")}
            onClick={save}
            title="Save (Ctrl+S)"
          >
            <Save className="size-3.5" /> Save
          </Button>
        </div>
      </div>

      {/* URL bar */}
      <div className="flex items-center gap-2 px-3 pb-2">
        <div className="flex min-w-0 flex-1 items-center rounded-md border border-input">
          <Select
            value={HTTP_METHODS.includes(d.method) ? d.method : d.method}
            onValueChange={(method) => set({ method })}
          >
            <SelectTrigger
              className={cn(
                "h-9 w-28 shrink-0 rounded-r-none border-0 border-r font-mono text-xs font-bold",
                methodColor(d.method),
              )}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {HTTP_METHODS.map((m) => (
                <SelectItem key={m} value={m} className={cn("font-mono text-xs font-bold", methodColor(m))}>
                  {m}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <VarInput
            value={d.url}
            onChange={onUrlChange}
            onEnter={send}
            onPasteText={onPaste}
            placeholder="Enter URL or paste a cURL command"
            className="h-9 flex-1 border-0 focus-within:ring-0"
          />
        </div>
        {tab.sending ? (
          <Button variant="secondary" className="h-9 w-24" onClick={() => cancelSend(tab.id)}>
            <Loader2 className="size-4 animate-spin" /> Cancel
          </Button>
        ) : (
          <Button
            className="h-9 w-24"
            onClick={send}
            title={isWebSocket ? "Connect (Ctrl+Enter)" : "Send (Ctrl+Enter)"}
          >
            {isWebSocket ? "Connect" : "Send"}
          </Button>
        )}
        <Button
          hidden={isWebSocket}
          variant="outline"
          className="h-9"
          title="Open as a server-sent event stream and show events live"
          onClick={() => setStreamKey(d.url.trim() ? Date.now() : null)}
        >
          Stream
        </Button>
      </div>

      <Group orientation={sideBySide ? "horizontal" : "vertical"} className="min-h-0 flex-1">
        <Panel defaultSize="45" minSize="15">
          <Tabs defaultValue="params" className="flex h-full min-h-0 flex-col gap-0">
            <TabsList className="mx-3 h-8 shrink-0 justify-start bg-transparent p-0">
              <TabsTrigger value="params" className="text-xs">
                <TabLabel label="Params" n={count(d.params)} />
              </TabsTrigger>
              <TabsTrigger value="auth" className="text-xs">
                <TabLabel label="Authorization" dot={d.auth.type !== "inherit" && d.auth.type !== "none"} />
              </TabsTrigger>
              <TabsTrigger value="headers" className="text-xs">
                <TabLabel label="Headers" n={count(d.headers)} />
              </TabsTrigger>
              <TabsTrigger value="body" className="text-xs">
                <TabLabel label="Body" dot={d.body.mode !== "none"} />
              </TabsTrigger>
              <TabsTrigger value="pre" className="text-xs">
                <TabLabel label="Pre-request Script" dot={!!d.preRequestScript.trim()} />
              </TabsTrigger>
              <TabsTrigger value="test" className="text-xs">
                <TabLabel label="Post-response Script" dot={!!d.testScript.trim()} />
              </TabsTrigger>
              <TabsTrigger value="settings" className="text-xs">
                Settings
              </TabsTrigger>
            </TabsList>
            <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
              <TabsContent value="params" className="mt-0">
                <div className="mb-1 text-[11px] font-medium text-muted-foreground">QUERY PARAMS</div>
                <KeyValueEditor rows={d.params} onChange={onParamsChange} showDescription />
              </TabsContent>
              <TabsContent value="auth" className="mt-0">
                <AuthEditor auth={d.auth} onChange={(auth) => set({ auth })} folderId={d.folderId} />
              </TabsContent>
              <TabsContent value="headers" className="mt-0">
                <KeyValueEditor rows={d.headers} onChange={(headers) => set({ headers })} showDescription />
                <p className="mt-2 text-[11px] text-muted-foreground">
                  Headers from parent folders/collection are merged in when sending. User-Agent, Accept and
                  Accept-Encoding are added automatically unless set here.
                </p>
              </TabsContent>
              <TabsContent value="body" className="mt-0 h-full">
                <BodyEditor body={d.body} onChange={(body) => set({ body })} draft={d as RequestDef} />
              </TabsContent>
              <TabsContent value="pre" className="mt-0 h-full">
                <ScriptEditor
                  kind="pre"
                  value={d.preRequestScript}
                  onChange={(preRequestScript) => set({ preRequestScript })}
                />
              </TabsContent>
              <TabsContent value="test" className="mt-0 h-full">
                <ScriptEditor
                  kind="test"
                  value={d.testScript}
                  onChange={(testScript) => set({ testScript })}
                />
              </TabsContent>
              <TabsContent value="settings" className="mt-0">
                <SettingsEditor settings={d.settings} onChange={(settings) => set({ settings })} />
              </TabsContent>
            </div>
          </Tabs>
        </Panel>
        <Separator
          className={cn(
            "bg-transparent transition-colors hover:bg-primary/40 data-[separator=active]:bg-primary/60",
            sideBySide ? "w-1 border-l" : "h-1 border-t",
          )}
        />
        <Panel defaultSize="55" minSize="10">
          {wsKey !== null && isWebSocket ? (
            <WebSocketPanel key={wsKey} draft={d as RequestDef} onClose={() => setWsKey(null)} />
          ) : streamKey !== null ? (
            <EventStreamPanel key={streamKey} draft={d as RequestDef} onClose={() => setStreamKey(null)} />
          ) : (
            <ResponseViewer
              result={tab.result}
              sending={tab.sending}
              onCancel={() => cancelSend(tab.id)}
              onSaveExample={tab.requestId ? saveExample : undefined}
            />
          )}
        </Panel>
      </Group>
    </div>
  );
}
