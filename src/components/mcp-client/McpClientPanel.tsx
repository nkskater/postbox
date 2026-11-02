"use client";
import { useEffect, useRef, useState } from "react";
import { useApp } from "@/stores/app";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  mcpActionSchema,
  mcpCallSchema,
  mcpConnectionSchema,
  type McpAction,
  type McpCall,
} from "@/core/mcp-client/model";
type Saved = { id: string; revision: number; name: string; config: McpCall };
type Session = {
  id: string;
  server?: { name: string; version: string };
  capabilities?: Record<string, unknown>;
  instructions?: string;
  protocolVersion?: string;
};
async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch("/api/mcp-client/" + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "MCP request failed");
  return data;
}
export function McpClientPanel() {
  const workspaceId = useApp((s) => s.workspaceId),
    environmentId = useApp((s) => s.environmentId);
  return workspaceId ? (
    <Client key={workspaceId + ":" + environmentId} workspaceId={workspaceId} environmentId={environmentId} />
  ) : (
    <p className="p-4">Select a workspace.</p>
  );
}
function Client({ workspaceId, environmentId }: { workspaceId: string; environmentId: string | null }) {
  const [name, setName] = useState("MCP call"),
    [url, setUrl] = useState(""),
    [headers, setHeaders] = useState("[]"),
    [type, setType] = useState<McpAction["type"]>("tools/list"),
    [target, setTarget] = useState(""),
    [args, setArgs] = useState("{}");
  const [saved, setSaved] = useState<Saved[]>([]),
    [selected, setSelected] = useState<Saved | null>(null),
    [session, setSession] = useState<Session | null>(null),
    [result, setResult] = useState<Record<string, unknown> | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [discovery, setDiscovery] = useState<Record<string, unknown> | null>(null);
  const live = useRef(true),
    sessionId = useRef("");
  useEffect(() => {
    live.current = true;
    request<Saved[]>("GET", "calls?workspaceId=" + encodeURIComponent(workspaceId))
      .then((value) => {
        if (live.current) setSaved(value);
      })
      .catch((error) => {
        if (live.current) setError(error.message);
      });
    return () => {
      live.current = false;
      if (sessionId.current)
        void fetch("/api/mcp-client/sessions/" + sessionId.current, {
          method: "DELETE",
          keepalive: true,
        }).catch(() => {});
    };
  }, [workspaceId]);
  const connection = () => mcpConnectionSchema.parse({ url, headers: JSON.parse(headers) });
  const action = () =>
    mcpActionSchema.parse(
      type === "tools/call" || type === "prompts/get"
        ? { type, name: target, arguments: JSON.parse(args) }
        : type === "resources/read"
          ? { type, uri: target }
          : { type },
    );
  const guard = async (fn: () => Promise<void>) => {
    setError("");
    setBusy(true);
    try {
      await fn();
    } catch (error) {
      if (live.current) setError(error instanceof Error ? error.message : "MCP operation failed");
    } finally {
      if (live.current) setBusy(false);
    }
  };
  const disconnect = async () => {
    const id = sessionId.current;
    sessionId.current = "";
    setSession(null);
    if (id) await request("DELETE", "sessions/" + id);
  };
  const connect = () =>
    guard(async () => {
      await disconnect();
      const value = await request<Session>("POST", "sessions", {
        workspaceId,
        environmentId,
        connection: connection(),
      });
      if (!live.current) {
        void request("DELETE", "sessions/" + value.id);
        return;
      }
      sessionId.current = value.id;
      setSession(value);
      setResult(null);
      setDiscovery(null);
    });
  const run = (override?: McpAction) =>
    guard(async () => {
      if (!session) throw new Error("Connect to a server first");
      const a = override ?? action();
      const value = await request<Record<string, unknown>>("POST", "sessions/" + session.id, { action: a });
      if (!live.current) return;
      setResult(value);
      if (a.type.endsWith("/list")) setDiscovery(value);
    });
  const refresh = async () =>
    setSaved(await request<Saved[]>("GET", "calls?workspaceId=" + encodeURIComponent(workspaceId)));
  const save = () =>
    guard(async () => {
      const config = mcpCallSchema.parse({ name, connection: connection(), action: action() });
      const value = selected
        ? await request<Saved>("PATCH", "calls/" + selected.id, {
            ...config,
            expectedRevision: selected.revision,
          })
        : await request<Saved>("POST", "calls", { workspaceId, ...config });
      setSelected(value);
      await refresh();
    });
  const load = (value: Saved) =>
    guard(async () => {
      await disconnect();
      setSelected(value);
      setName(value.name);
      setUrl(value.config.connection.url);
      setHeaders(JSON.stringify(value.config.connection.headers, null, 2));
      setType(value.config.action.type);
      setTarget(
        "name" in value.config.action
          ? value.config.action.name
          : "uri" in value.config.action
            ? value.config.action.uri
            : "",
      );
      setArgs(
        "arguments" in value.config.action ? JSON.stringify(value.config.action.arguments, null, 2) : "{}",
      );
      setResult(null);
      setDiscovery(null);
    });
  const remove = () =>
    guard(async () => {
      if (!selected) return;
      await request("DELETE", "calls/" + selected.id);
      setSelected(null);
      await refresh();
    });
  const items = discovery
    ? (["tools", "resources", "resourceTemplates", "prompts"] as const).flatMap((kind) =>
        Array.isArray(discovery[kind])
          ? (discovery[kind] as Record<string, unknown>[]).map((item) => ({ kind, item }))
          : [],
      )
    : [];
  return (
    <div className="h-full overflow-auto p-4 space-y-4">
      <h1 className="text-lg font-semibold">MCP client</h1>
      <p className="text-xs text-muted-foreground">
        Connect to a Streamable HTTP server. Saved calls use workspace/global and active environment
        variables. Remote tools run only when you choose Run operation.
      </p>
      <div className="flex flex-wrap gap-2 items-center">
        <label>
          Saved call{" "}
          <select
            aria-label="Saved MCP call"
            value={selected?.id ?? ""}
            disabled={busy}
            onChange={(e) => {
              const value = saved.find((v) => v.id === e.target.value);
              if (value) void load(value);
              else setSelected(null);
            }}
            className="rounded border bg-background p-2 ml-2"
          >
            <option value="">New call</option>
            {saved.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </label>
        <Input
          aria-label="MCP call name"
          className="max-w-60"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Button disabled={busy} variant="outline" onClick={() => void save()}>
          Save call
        </Button>
        <Button disabled={busy || !selected} variant="outline" onClick={() => void remove()}>
          Delete saved call
        </Button>
      </div>
      <div className="flex gap-2">
        <Input
          aria-label="MCP server URL"
          placeholder="https://example.com/mcp or {{mcpUrl}}"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={!!session || busy}
        />
        <Button onClick={() => void connect()} disabled={busy || !!session || !url}>
          Connect
        </Button>
        <Button variant="outline" onClick={() => void guard(disconnect)} disabled={busy || !session}>
          Disconnect
        </Button>
      </div>
      <label className="block text-sm">
        MCP headers (JSON array of key/value pairs)
        <Textarea
          aria-label="MCP headers"
          value={headers}
          onChange={(e) => setHeaders(e.target.value)}
          disabled={!!session || busy}
          className="mt-1 font-mono text-xs"
        />
      </label>
      <p className="text-xs text-muted-foreground">
        Use {"{{token}}"} references for saved authorization headers. Inline credentials are used only for the
        current connection and cannot be saved.
      </p>
      {session && (
        <section className="rounded border p-3 space-y-2">
          <h2 className="font-medium">
            Connected to {session.server?.name ?? "MCP server"} {session.server?.version}
          </h2>
          <pre className="whitespace-pre-wrap text-xs">{JSON.stringify(session.capabilities, null, 2)}</pre>
          {session.instructions && <p className="whitespace-pre-wrap text-xs">{session.instructions}</p>}
          <div className="flex flex-wrap gap-2">
            {(["tools/list", "resources/list", "resources/templates/list", "prompts/list"] as const).map(
              (value) => (
                <Button
                  key={value}
                  size="sm"
                  variant="outline"
                  disabled={busy || !session.capabilities?.[value.split("/")[0]]}
                  onClick={() => {
                    setType(value);
                    void run({ type: value });
                  }}
                >
                  {value}
                </Button>
              ),
            )}
          </div>
        </section>
      )}
      <div className="flex gap-3 items-center">
        <label>
          Operation{" "}
          <select
            aria-label="MCP operation"
            value={type}
            onChange={(e) => setType(e.target.value as McpAction["type"])}
            disabled={busy}
            className="ml-2 rounded border bg-background p-2"
          >
            {[
              "tools/list",
              "tools/call",
              "resources/list",
              "resources/templates/list",
              "resources/read",
              "prompts/list",
              "prompts/get",
            ].map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </label>
        <Button disabled={busy || !session} onClick={() => void run()}>
          Run operation
        </Button>
        {typeof result?.nextCursor === "string" && type.endsWith("/list") && (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void run({ type: type as "tools/list", cursor: result.nextCursor as string })}
          >
            Next page
          </Button>
        )}
      </div>
      {(type === "tools/call" || type === "prompts/get" || type === "resources/read") && (
        <Input
          aria-label="MCP operation target"
          placeholder={type === "resources/read" ? "Resource URI" : "Tool or prompt name"}
          value={target}
          onChange={(e) => setTarget(e.target.value)}
        />
      )}
      {(type === "tools/call" || type === "prompts/get") && (
        <label className="block text-sm">
          Arguments (JSON object)
          <Textarea
            aria-label="MCP arguments"
            value={args}
            onChange={(e) => setArgs(e.target.value)}
            className="font-mono text-xs mt-1"
          />
        </label>
      )}
      {!!items.length && (
        <section className="space-y-2">
          <h2 className="font-medium">Discovered items</h2>
          {items.map(({ kind, item }, index) => (
            <div key={kind + index} className="rounded border p-2">
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setType(
                    kind === "tools" ? "tools/call" : kind === "prompts" ? "prompts/get" : "resources/read",
                  );
                  setTarget(String(item.uri ?? item.uriTemplate ?? item.name ?? ""));
                  setArgs("{}");
                }}
              >
                {String(item.name ?? item.uri ?? item.uriTemplate ?? "Item")}
              </Button>
              {typeof item.description === "string" && (
                <p className="text-xs mt-2 whitespace-pre-wrap">{item.description}</p>
              )}
              {item.inputSchema !== undefined && (
                <pre className="overflow-auto whitespace-pre-wrap text-xs mt-2">
                  {JSON.stringify(item.inputSchema, null, 2)}
                </pre>
              )}
              {item.arguments !== undefined && (
                <pre className="whitespace-pre-wrap text-xs">{JSON.stringify(item.arguments, null, 2)}</pre>
              )}
            </div>
          ))}
        </section>
      )}
      {error && (
        <p role="alert" className="text-destructive whitespace-pre-wrap">
          {error}
        </p>
      )}
      {result && (
        <section>
          <h2 className="font-medium mb-2">Operation result</h2>
          <pre
            aria-label="MCP result"
            className="rounded border p-3 overflow-auto whitespace-pre-wrap text-xs"
          >
            {JSON.stringify(result, null, 2)}
          </pre>
        </section>
      )}
    </div>
  );
}
