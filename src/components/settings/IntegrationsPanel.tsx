"use client";
/** Copy-ready setup commands for MCP clients (Claude Code, Cursor, Open WebUI). */
import { useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { copyText } from "@/lib/clipboard";
import { setupSnippets } from "@/lib/mcp-setup";

function Snippet({ title, text }: { title: string; text: string }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-medium">{title}</h4>
        <Button
          variant="outline"
          size="sm"
          className="h-7"
          onClick={() =>
            void copyText(text).then((ok) =>
              ok
                ? toast.success(`${title} copied`)
                : toast.error("Could not copy. Select the text and copy it manually."),
            )
          }
        >
          <Copy className="size-3.5" /> Copy
        </Button>
      </div>
      <pre className="overflow-x-auto rounded-md border bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap break-all">
        {text}
      </pre>
    </div>
  );
}

export function IntegrationsPanel({ isAdmin }: { isAdmin: boolean }) {
  // The origin only exists in the browser; the server render has none.
  const origin = useSyncExternalStore(
    () => () => undefined,
    () => window.location.origin,
    () => "",
  );
  const endpoint = origin ? `${origin}/api/mcp` : "";
  const [authRequired, setAuthRequired] = useState(true);
  useEffect(() => {
    if (!isAdmin) return;
    // Sign-in may be off on a trusted LAN; then the clients need no token.
    void fetch("/api/admin/security")
      .then((r) => (r.ok ? r.json() : null))
      .then((info) => info && setAuthRequired(info.auth.mode !== "open"))
      .catch(() => undefined);
  }, [isAdmin]);
  if (!endpoint) return null;
  const snippets = setupSnippets(endpoint, authRequired);
  return (
    <section className="space-y-4 rounded-lg border p-4" aria-label="Connect an MCP client">
      <div>
        <h3 className="font-medium">Connect an MCP client</h3>
        <p className="text-sm text-muted-foreground">
          {authRequired ? (
            <>
              Replace <code>YOUR_TOKEN</code> with a personal API token from your{" "}
              <Link href="/profile" className="underline">
                profile
              </Link>
              . The token acts as you, so the client sees only what you can.
            </>
          ) : (
            "Sign-in is off, so no token is needed."
          )}
        </p>
      </div>
      <Snippet title="Claude Code" text={snippets.claudeCode} />
      <Snippet title="Cursor (mcp.json)" text={snippets.cursor} />
      <Snippet title="Open WebUI" text={snippets.openWebUi} />
    </section>
  );
}
