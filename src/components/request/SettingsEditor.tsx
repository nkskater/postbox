"use client";
import type { HttpVersionMode, RequestSettings } from "@/core/types";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";

function Row({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 border-b py-3 last:border-b-0">
      <div>
        <div className="text-sm">{title}</div>
        <div className="text-xs text-muted-foreground">{hint}</div>
      </div>
      {children}
    </div>
  );
}

/** Per-request transport settings. */
export function SettingsEditor({
  settings,
  onChange,
}: {
  settings: RequestSettings;
  onChange: (s: RequestSettings) => void;
}) {
  const set = (patch: Partial<RequestSettings>) => onChange({ ...settings, ...patch });
  return (
    <div className="max-w-2xl">
      <Row
        title="Enable SSL certificate verification"
        hint="Turn off to allow self-signed or expired certificates."
      >
        <Switch checked={settings.verifySsl} onCheckedChange={(verifySsl) => set({ verifySsl })} />
      </Row>
      <Row title="Automatically follow redirects" hint="Follow HTTP 3xx responses.">
        <Switch
          checked={settings.followRedirects}
          onCheckedChange={(followRedirects) => set({ followRedirects })}
        />
      </Row>
      <Row title="Maximum number of redirects" hint="Stop following after this many hops.">
        <Input
          type="number"
          className="h-8 w-24"
          value={settings.maxRedirects}
          min={0}
          onChange={(e) => set({ maxRedirects: Math.max(0, Number(e.target.value) || 0) })}
        />
      </Row>
      <Row title="Request timeout (ms)" hint="Abort the request if no response arrives in time.">
        <Input
          type="number"
          className="h-8 w-28"
          value={settings.timeoutMs}
          min={100}
          onChange={(e) => set({ timeoutMs: Math.max(100, Number(e.target.value) || 30000) })}
        />
      </Row>
      <Row title="Use cookie jar" hint="Send stored cookies and save cookies set by the server.">
        <Switch checked={settings.useCookieJar} onCheckedChange={(useCookieJar) => set({ useCookieJar })} />
      </Row>
      <Row
        title="Socket.IO connection"
        hint="Connect to a Socket.IO server instead of sending an HTTP request."
      >
        <Switch
          checked={!!settings.socketio}
          onCheckedChange={(on) => set({ socketio: on ? (settings.socketio ?? {}) : undefined })}
        />
      </Row>
      {settings.socketio && (
        <>
          <Row title="Socket.IO namespace" hint="For example /chat; the default namespace is /.">
            <Input
              className="h-8 w-48 font-mono text-xs"
              value={settings.socketio.namespace ?? ""}
              placeholder="/"
              onChange={(e) =>
                set({ socketio: { ...settings.socketio, namespace: e.target.value || undefined } })
              }
            />
          </Row>
          <Row title="Socket.IO path" hint="Server path, usually /socket.io.">
            <Input
              className="h-8 w-48 font-mono text-xs"
              value={settings.socketio.path ?? ""}
              placeholder="/socket.io"
              onChange={(e) => set({ socketio: { ...settings.socketio, path: e.target.value || undefined } })}
            />
          </Row>
          <Row title="Acknowledgement timeout (ms)" hint="How long to wait for an ack when one is requested.">
            <Input
              type="number"
              className="h-8 w-28"
              value={settings.socketio.ackTimeoutMs ?? 5000}
              min={100}
              onChange={(e) =>
                set({
                  socketio: {
                    ...settings.socketio,
                    ackTimeoutMs: Math.max(100, Number(e.target.value) || 5000),
                  },
                })
              }
            />
          </Row>
        </>
      )}
      <Row
        title="HTTP version"
        hint="Auto negotiates HTTP/2 over TLS and falls back to HTTP/1.1. HTTP/2 requires it (plain http:// uses prior knowledge). Not used with sockets or NTLM."
      >
        <select
          aria-label="HTTP version"
          className="h-8 rounded border bg-background px-2 text-xs"
          value={settings.httpVersion ?? "http1"}
          onChange={(e) =>
            set({ httpVersion: e.target.value === "http1" ? undefined : (e.target.value as HttpVersionMode) })
          }
        >
          <option value="http1">HTTP/1.1</option>
          <option value="auto">Auto (HTTP/2 if offered)</option>
          <option value="http2">HTTP/2 only</option>
        </select>
      </Row>
      <Row
        title="Unix socket or named pipe"
        hint="Connect here instead of over TCP; the URL still sets the path and Host. The server must allow it in PROXY_ALLOW_SOCKETS."
      >
        <Input
          className="h-8 w-72 font-mono text-xs"
          value={settings.socketPath ?? ""}
          placeholder="/var/run/app.sock or \\.\pipe\name"
          onChange={(e) => set({ socketPath: e.target.value || undefined })}
        />
      </Row>
    </div>
  );
}
