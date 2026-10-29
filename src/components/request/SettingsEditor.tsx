"use client";
import type { RequestSettings } from "@/core/types";
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
    </div>
  );
}
