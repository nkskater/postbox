"use client";

import { useState } from "react";
import type { RecordedBody } from "@/core/runner/details";
import type { RunResult } from "@/core/runner/runner";
import { formatBytes, formatMs } from "@/lib/format";
import { prettyRecordedBody } from "@/lib/run-details";
import { Button } from "@/components/ui/button";

function Pairs({ title, pairs }: { title: string; pairs?: [string, string][] }) {
  return (
    <section className="min-w-0 space-y-1">
      <h4 className="font-medium">{title}</h4>
      {!pairs ? (
        <p className="text-muted-foreground">Not retained for this execution.</p>
      ) : !pairs.length ? (
        <p className="text-muted-foreground">None</p>
      ) : (
        <dl className="max-h-64 overflow-auto rounded border bg-background p-2 font-mono">
          {pairs.map(([name, value], index) => (
            <div
              key={index}
              className="grid grid-cols-[minmax(6rem,1fr)_3fr] gap-3 border-b py-1 last:border-0"
            >
              <dt className="whitespace-pre-wrap break-all">{name}</dt>
              <dd className="whitespace-pre-wrap break-all">{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

function Body({
  title,
  body,
  contentType = "",
}: {
  title: string;
  body?: RecordedBody;
  contentType?: string;
}) {
  const [view, setView] = useState<"pretty" | "raw">("pretty");
  return (
    <section className="min-w-0 space-y-1">
      <div className="flex items-center gap-2">
        <h4 className="mr-auto font-medium">{title}</h4>
        {body?.text !== undefined &&
          (["pretty", "raw"] as const).map((mode) => (
            <Button
              key={mode}
              size="sm"
              variant={view === mode ? "secondary" : "ghost"}
              aria-pressed={view === mode}
              onClick={() => setView(mode)}
            >
              {mode === "pretty" ? "Pretty" : "Raw"}
            </Button>
          ))}
      </div>
      {body?.state === "truncated" && (
        <p role="status" className="text-warning">
          {body.reason ?? "Only a captured portion is available."}
        </p>
      )}
      {!body || body.state === "unavailable" ? (
        <p className="text-muted-foreground">
          {body?.reason ?? "Body unavailable: not retained for this execution."}
        </p>
      ) : body.text === "" ? (
        <p className="text-muted-foreground">Empty body</p>
      ) : (
        <pre className="max-h-96 overflow-auto rounded border bg-background p-2 font-mono whitespace-pre-wrap break-all">
          {view === "pretty" ? prettyRecordedBody(body.text ?? "", contentType) : body.text}
        </pre>
      )}
    </section>
  );
}

export function RunResultDetails({ result }: { result: RunResult }) {
  const details = result.executionDetails;
  const request = details?.request;
  const response = details?.response;
  let query: [string, string][] | undefined;
  try {
    if (request) query = [...new URL(request.url).searchParams.entries()];
  } catch {
    /* Invalid recorded URLs remain visible below. */
  }
  const legacyBody: RecordedBody | undefined =
    result.responseBody === undefined
      ? undefined
      : {
          text: result.responseBody,
          state: "truncated",
          reason: "Legacy response excerpt; completeness was not recorded.",
        };
  return (
    <div className="min-w-0 space-y-4 text-xs">
      <p className="font-medium">
        Iteration {result.iteration + 1} · Execution {result.sequence + 1} · {formatMs(result.timeMs)} ·{" "}
        {formatBytes(result.size)}
      </p>
      <section className="space-y-2">
        <h3 className="font-semibold">Recorded request</h3>
        {request && (
          <p className="text-muted-foreground">
            Recorded before redirects. Headers added by the transport are not retained.
          </p>
        )}
        <p className="font-mono whitespace-pre-wrap break-all">
          {request?.method ?? result.method} {request?.url ?? result.url}
        </p>
        {!request && (
          <p className="text-muted-foreground">
            Effective request details were not retained for this execution.
          </p>
        )}
        <Pairs title="Query parameters" pairs={query} />
        <Pairs title="Request headers" pairs={request?.headers} />
        <Body
          title="Request body"
          body={request?.body}
          contentType={request?.headers.find(([name]) => name.toLowerCase() === "content-type")?.[1]}
        />
      </section>
      <section className="space-y-2">
        <h3 className="font-semibold">
          Recorded response · {result.status ?? "Unavailable"} {result.statusText}
        </h3>
        {response?.url && (
          <p className="font-mono whitespace-pre-wrap break-all">Final URL: {response.url}</p>
        )}
        {response && (
          <p>
            DNS {formatMs(response.timings.dns)} · TCP {formatMs(response.timings.tcp)} · TLS{" "}
            {formatMs(response.timings.tls)} · TTFB {formatMs(response.timings.ttfb)} · Download{" "}
            {formatMs(response.timings.download)}
          </p>
        )}
        <Pairs title="Response headers" pairs={response?.headers ?? result.responseHeaders} />
        <Body title="Response body" body={response?.body ?? legacyBody} contentType={response?.contentType} />
      </section>
    </div>
  );
}
