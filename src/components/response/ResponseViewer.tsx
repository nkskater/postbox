"use client";
/**
 * Response panel: status/time/size summary with timing breakdown, body
 * (Pretty / Raw / Preview with folding and Ctrl+F search), headers, cookies,
 * test results and the request that was actually sent.
 */
import { copyText } from "@/lib/clipboard";
import { useMemo, useState } from "react";
import { AlertTriangle, Check, Copy, Download, Save, Send, X, WrapText } from "lucide-react";
import { toast } from "sonner";
import type { ProxyResult } from "@/lib/api";
import type { Timings } from "@/core/types";
import { CodeEditor, type EditorLanguage } from "@/components/editor/CodeEditor";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { formatBytes, formatMs, formatXml, statusColor } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useSetting } from "@/stores/settings";

function detectLanguage(contentType: string, body: string): EditorLanguage {
  const ct = contentType.toLowerCase();
  if (ct.includes("json")) return "json";
  if (ct.includes("html")) return "html";
  if (ct.includes("xml")) return "xml";
  if (ct.includes("javascript")) return "javascript";
  const t = body.trimStart();
  if (t.startsWith("{") || t.startsWith("[")) return "json";
  if (t.startsWith("<"))
    return t.toLowerCase().startsWith("<!doctype html") || t.startsWith("<html") ? "html" : "xml";
  return "text";
}

function prettify(body: string, lang: EditorLanguage): string {
  try {
    if (lang === "json") return JSON.stringify(JSON.parse(body), null, 2);
    if (lang === "xml") return formatXml(body);
  } catch {
    /* fall back to raw */
  }
  return body;
}

function TimingBreakdown({ t }: { t: Timings }) {
  const rows: [string, number][] = [
    ["DNS Lookup", t.dns],
    ["TCP Handshake", t.tcp],
    ["SSL Handshake", t.tls],
    ["Waiting (TTFB)", t.ttfb],
    ["Content Download", t.download],
  ];
  const max = Math.max(1, t.total);
  let offset = 0;
  return (
    <div className="w-80 space-y-2 text-xs">
      <div className="flex justify-between font-medium">
        <span>Response Time</span>
        <span>{formatMs(t.total)}</span>
      </div>
      {rows.map(([label, v]) => {
        const left = (offset / max) * 100;
        offset += v;
        return (
          <div key={label} className="grid grid-cols-[110px_1fr_60px] items-center gap-2">
            <span className="text-muted-foreground">{label}</span>
            <div className="relative h-2 rounded bg-muted">
              <div
                className="absolute h-2 rounded bg-primary"
                style={{ left: `${left}%`, width: `${Math.max(1, (v / max) * 100)}%` }}
              />
            </div>
            <span className="text-right tabular-nums">{formatMs(v)}</span>
          </div>
        );
      })}
    </div>
  );
}

export function ResponseViewer({
  result,
  sending,
  onCancel,
  onSaveExample,
}: {
  result: ProxyResult | null | undefined;
  sending?: boolean;
  onCancel?: () => void;
  onSaveExample?: () => void;
}) {
  const defaultView = useSetting<"pretty" | "raw" | "preview">("responses.defaultView");
  const wrapDefault = useSetting<boolean>("responses.wrap");
  const maxRenderBytes = (Number(useSetting<number>("responses.maxRenderKb")) || 2048) * 1024;
  const openTestsOnFailure = useSetting<boolean>("responses.openTestsOnFailure");
  const [view, setView] = useState<"pretty" | "raw" | "preview">(defaultView);
  const [wrap, setWrap] = useState(wrapDefault);
  const [tab, setTab] = useState("body");
  const [renderFull, setRenderFull] = useState(false);
  // React to a new result during render (not in an effect): reset the large-body view and
  // jump to Test Results when a test failed.
  const [seenResult, setSeenResult] = useState(result);
  if (result !== seenResult) {
    setSeenResult(result);
    setRenderFull(false);
    if (openTestsOnFailure && result?.tests.some((t) => !t.passed && !t.skipped)) setTab("tests");
  }
  const res = result?.response;
  const tooLarge = !!res && !renderFull && res.bodyText.length > maxRenderBytes;
  const lang = useMemo(() => (res ? detectLanguage(res.contentType, res.bodyText) : "text"), [res]);
  // Prettifying huge bodies is expensive, so it only happens once the full body is shown.
  const pretty = useMemo(() => (res && !tooLarge ? prettify(res.bodyText, lang) : ""), [res, lang, tooLarge]);

  if (sending) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
        <Send className="size-6 animate-pulse" />
        <span>Sending request…</span>
        {onCancel && (
          <Button variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    );
  }
  if (!result) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
        <Send className="size-8 opacity-40" />
        <span>Enter a URL and click Send to get a response</span>
        <span className="text-xs opacity-70">Ctrl+Enter to send · Ctrl+S to save</span>
      </div>
    );
  }
  if (result.skipped) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        Request skipped by pre-request script
      </div>
    );
  }

  const passed = result.tests.filter((t) => t.passed && !t.skipped).length;
  const failed = result.tests.filter((t) => !t.passed).length;

  const copyBody = () => {
    void copyText(view === "pretty" && !tooLarge ? pretty : (res?.bodyText ?? "")).then((ok) =>
      ok ? toast.success("Copied to clipboard") : toast.error("Could not copy the response"),
    );
  };
  const download = () => {
    if (!res) return;
    const bytes = Uint8Array.from(atob(res.bodyBase64), (c) => c.charCodeAt(0));
    const blob = new Blob([bytes], { type: res.contentType || "application/octet-stream" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `response${lang === "json" ? ".json" : lang === "xml" ? ".xml" : lang === "html" ? ".html" : ""}`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const isImage = res?.contentType.startsWith("image/");
  const isPdf = res?.contentType.includes("pdf");
  const previewCsp =
    "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none';";
  const escapeHtml = (value: string) =>
    value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const previewDocument = (content: string) =>
    `<!doctype html><meta http-equiv="Content-Security-Policy" content="${previewCsp}"><meta name="referrer" content="no-referrer">${content}`;

  return (
    <Tabs value={tab} onValueChange={setTab} className="flex h-full min-h-0 flex-col gap-0">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b px-3 py-1">
        <TabsList className="h-8 bg-transparent p-0">
          <TabsTrigger value="body" className="text-xs">
            Body
          </TabsTrigger>
          <TabsTrigger value="cookies" className="text-xs">
            Cookies{" "}
            {res?.cookies.length ? (
              <span className="text-muted-foreground">({res.cookies.length})</span>
            ) : null}
          </TabsTrigger>
          <TabsTrigger value="headers" className="text-xs">
            Headers {res ? <span className="text-muted-foreground">({res.headers.length})</span> : null}
          </TabsTrigger>
          <TabsTrigger value="tests" className="text-xs">
            Test Results{" "}
            {result.tests.length > 0 && (
              <span className={failed ? "text-destructive" : "text-success"}>
                ({passed}/{result.tests.length})
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="visualization" className="text-xs">
            Visualization
          </TabsTrigger>
          <TabsTrigger value="sent" className="text-xs">
            Request
          </TabsTrigger>
        </TabsList>
        <div className="ml-auto flex items-center gap-3 text-xs">
          {res ? (
            <>
              <span className="text-muted-foreground">
                Status:{" "}
                <span className={cn("font-medium", statusColor(res.status))}>
                  {res.status} {res.statusText}
                </span>
              </span>
              <Popover>
                <PopoverTrigger className="cursor-pointer text-muted-foreground hover:text-foreground">
                  Time: <span className="font-medium text-success">{formatMs(res.timings.total)}</span>
                </PopoverTrigger>
                <PopoverContent className="w-auto">
                  <TimingBreakdown t={res.timings} />
                  {res.redirects.length > 0 && (
                    <div className="mt-3 border-t pt-2 text-xs">
                      <div className="mb-1 font-medium">Redirects</div>
                      {res.redirects.map((r, i) => (
                        <div key={i} className="truncate text-muted-foreground">
                          {r.status} → {r.url}
                        </div>
                      ))}
                    </div>
                  )}
                </PopoverContent>
              </Popover>
              <Popover>
                <PopoverTrigger className="cursor-pointer text-muted-foreground hover:text-foreground">
                  Size:{" "}
                  <span className="font-medium text-success">{formatBytes(res.size + res.headersSize)}</span>
                </PopoverTrigger>
                <PopoverContent className="w-56 text-xs">
                  <div className="flex justify-between">
                    <span>Headers</span>
                    <span>{formatBytes(res.headersSize)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Body</span>
                    <span>{formatBytes(res.size)}</span>
                  </div>
                  {res.remoteAddress && (
                    <div className="mt-2 text-muted-foreground">Remote: {res.remoteAddress}</div>
                  )}
                  <div className="text-muted-foreground">HTTP/{res.httpVersion}</div>
                </PopoverContent>
              </Popover>
              {onSaveExample && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={onSaveExample}
                  title="Save as example"
                >
                  <Save className="size-3.5" /> Save as example
                </Button>
              )}
            </>
          ) : (
            <span className="font-medium text-destructive">Error</span>
          )}
        </div>
      </div>

      {(result.scriptErrors.length > 0 || result.unresolved.length > 0) && (
        <div className="space-y-0.5 border-b bg-destructive/10 px-3 py-1.5 text-xs">
          {result.scriptErrors.map((e, i) => (
            <div key={i} className="flex items-start gap-2 text-destructive">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span>
                {e.source}: {e.message}
              </span>
            </div>
          ))}
          {result.unresolved.length > 0 && (
            <div className="flex items-start gap-2 text-warning">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span>Unresolved variables: {result.unresolved.map((v) => `{{${v}}}`).join(", ")}</span>
            </div>
          )}
        </div>
      )}

      <TabsContent value="body" className="flex min-h-0 flex-1 flex-col">
        {!res ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
            <AlertTriangle className="size-6 text-destructive" />
            <div className="font-medium">Could not send request</div>
            <div className="max-w-xl text-xs text-muted-foreground">{result.error}</div>
          </div>
        ) : (
          <>
            {res.truncated && (
              <div
                role="status"
                className="flex items-center gap-2 border-b bg-warning/10 px-3 py-1.5 text-xs text-warning"
              >
                <AlertTriangle className="size-3.5 shrink-0" />
                Response capture was truncated at the configured size limit. Download contains only the
                captured portion.
              </div>
            )}
            <div className="flex items-center gap-1 px-3 py-1">
              {(["pretty", "raw", "preview"] as const).map((v) => (
                <Button
                  key={v}
                  variant={view === v ? "secondary" : "ghost"}
                  size="sm"
                  className="h-6 px-2 text-xs capitalize"
                  onClick={() => setView(v)}
                >
                  {v}
                </Button>
              ))}
              <span className="ml-2 text-[11px] uppercase text-muted-foreground">
                {res.isBinary ? "binary" : lang}
              </span>
              <div className="ml-auto flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className={cn("size-6", wrap && "text-primary")}
                  title="Wrap lines"
                  onClick={() => setWrap(!wrap)}
                >
                  <WrapText className="size-3.5" />
                </Button>
                <Button variant="ghost" size="icon" className="size-6" title="Copy" onClick={copyBody}>
                  <Copy className="size-3.5" />
                </Button>
                <Button variant="ghost" size="icon" className="size-6" title="Download" onClick={download}>
                  <Download className="size-3.5" />
                </Button>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-hidden">
              {view === "preview" ? (
                isImage ? (
                  <iframe
                    title="Image response preview"
                    sandbox=""
                    referrerPolicy="no-referrer"
                    className="h-full w-full bg-white"
                    srcDoc={previewDocument(
                      `<style>body{margin:0;display:grid;place-items:center;height:100vh}img{max-width:100%;max-height:100vh;object-fit:contain}</style><img alt="Response preview" src="data:${res.contentType};base64,${res.bodyBase64}">`,
                    )}
                  />
                ) : isPdf ? (
                  <iframe
                    title="PDF preview"
                    sandbox=""
                    referrerPolicy="no-referrer"
                    className="h-full w-full"
                    src={`data:application/pdf;base64,${res.bodyBase64}`}
                  />
                ) : (
                  <iframe
                    title="Response preview"
                    sandbox=""
                    className="h-full w-full bg-white"
                    srcDoc={previewDocument(
                      lang === "html" ? res.bodyText : `<pre>${escapeHtml(res.bodyText)}</pre>`,
                    )}
                  />
                )
              ) : res.isBinary ? (
                <div className="p-6 text-center text-muted-foreground">
                  Binary response ({formatBytes(res.size)}, {res.contentType || "unknown type"}). Use Preview
                  or Download.
                </div>
              ) : tooLarge ? (
                <div className="flex h-full min-h-0 flex-col">
                  <div className="flex flex-wrap items-center gap-2 border-b bg-warning/10 px-3 py-1.5 text-xs">
                    <AlertTriangle className="size-3.5 text-warning" />
                    Large response ({formatBytes(res.size)}). Showing the first {formatBytes(maxRenderBytes)}{" "}
                    as raw text.
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 text-xs"
                      onClick={() => setRenderFull(true)}
                    >
                      Render full body
                    </Button>
                    <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={download}>
                      <Download className="size-3.5" /> Download
                    </Button>
                  </div>
                  <div className="min-h-0 flex-1">
                    <CodeEditor
                      value={res.bodyText.slice(0, maxRenderBytes)}
                      language="text"
                      readOnly
                      wrap={wrap}
                    />
                  </div>
                </div>
              ) : (
                <CodeEditor
                  value={view === "pretty" ? pretty : res.bodyText}
                  language={view === "pretty" ? lang : "text"}
                  readOnly
                  wrap={wrap}
                />
              )}
            </div>
          </>
        )}
      </TabsContent>

      <TabsContent value="visualization" className="min-h-0 flex-1 overflow-auto p-3">
        {result.visualizationResult?.error ? (
          <p role="alert" className="text-sm text-destructive">
            {result.visualizationResult.error}
          </p>
        ) : result.visualizationResult?.html ? (
          <iframe
            key={result.visualizationResult.html}
            title="Response visualization"
            sandbox=""
            referrerPolicy="no-referrer"
            className="h-full min-h-64 w-full rounded border bg-white"
            srcDoc={result.visualizationResult.html}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            Use pm.visualizer.set(template, data) in a request script to create a table or chart.
          </p>
        )}
      </TabsContent>
      <TabsContent value="headers" className="min-h-0 flex-1 overflow-auto p-3">
        <KeyValueTable rows={res?.headers ?? []} />
        {res?.trailers && res.trailers.length > 0 && (
          <div className="mt-4">
            <div className="mb-1 text-xs font-medium text-muted-foreground">Trailers</div>
            <KeyValueTable rows={res.trailers} />
          </div>
        )}
      </TabsContent>

      <TabsContent value="cookies" className="min-h-0 flex-1 overflow-auto p-3">
        {res?.cookies.length ? (
          <table className="w-full text-xs">
            <thead className="text-left text-muted-foreground">
              <tr>
                {["Name", "Value", "Domain", "Path", "Expires", "HttpOnly", "Secure"].map((h) => (
                  <th key={h} className="border-b px-2 py-1 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="font-mono">
              {res.cookies.map((c, i) => (
                <tr key={i} className="border-b">
                  <td className="px-2 py-1">{c.name}</td>
                  <td className="max-w-64 truncate px-2 py-1">{c.value}</td>
                  <td className="px-2 py-1">{c.domain}</td>
                  <td className="px-2 py-1">{c.path}</td>
                  <td className="px-2 py-1">
                    {c.expires ? new Date(c.expires).toLocaleString() : "Session"}
                  </td>
                  <td className="px-2 py-1">{c.httpOnly ? "✓" : ""}</td>
                  <td className="px-2 py-1">{c.secure ? "✓" : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-center text-xs text-muted-foreground">No cookies received from the server</p>
        )}
      </TabsContent>

      <TabsContent value="tests" className="min-h-0 flex-1 overflow-auto p-3">
        <TestResultsList tests={result.tests} />
      </TabsContent>

      <TabsContent value="sent" className="min-h-0 flex-1 overflow-auto p-3 text-xs">
        {result.sent ? (
          <div className="space-y-3">
            <div className="font-mono">
              <span className="font-semibold">{result.sent.method}</span>{" "}
              <span className="break-all">{result.sent.url}</span>
            </div>
            <KeyValueTable rows={result.sent.headers} />
            {result.sent.body && (
              <pre className="max-h-96 overflow-auto rounded-md border bg-muted/30 p-2 font-mono whitespace-pre-wrap">
                {result.sent.body}
              </pre>
            )}
          </div>
        ) : (
          <p className="text-muted-foreground">The request was not sent.</p>
        )}
      </TabsContent>
    </Tabs>
  );
}

function KeyValueTable({ rows }: { rows: [string, string][] }) {
  return (
    <table className="w-full text-xs">
      <tbody className="font-mono">
        {rows.map(([k, v], i) => (
          <tr key={i} className="border-b align-top">
            <td className="w-1/3 py-1 pr-4 font-medium text-muted-foreground">{k}</td>
            <td className="py-1 break-all">{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function TestResultsList({ tests }: { tests: ProxyResult["tests"] }) {
  if (!tests.length)
    return (
      <p className="text-center text-xs text-muted-foreground">
        No tests ran. Add tests in the Post-response script tab.
      </p>
    );
  return (
    <ul className="space-y-1 text-xs">
      {tests.map((t, i) => (
        <li key={i} className="flex items-start gap-2">
          <span
            className={cn(
              "mt-0.5 inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase",
              t.skipped
                ? "bg-muted text-muted-foreground"
                : t.passed
                  ? "bg-success/15 text-success"
                  : "bg-destructive/15 text-destructive",
            )}
          >
            {t.skipped ? "skip" : t.passed ? <Check className="size-3" /> : <X className="size-3" />}
            {t.skipped ? "" : t.passed ? "pass" : "fail"}
          </span>
          <div>
            <div>{t.name}</div>
            {t.error && <div className="text-muted-foreground">{t.error}</div>}
          </div>
        </li>
      ))}
    </ul>
  );
}
