"use client";
/** Shown when the UI throws: the real error, a retry, and the details to copy into a bug report. */
import { useEffect, useMemo, useState } from "react";
import { copyText } from "@/lib/clipboard";
import { formatCrashDetails } from "@/lib/crash-details";

export function CrashScreen({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => console.error("Postbox UI error:", error), [error]);
  const details = useMemo(
    () =>
      formatCrashDetails(error, {
        url: typeof location === "undefined" ? undefined : location.href,
        userAgent: typeof navigator === "undefined" ? undefined : navigator.userAgent,
      }),
    [error],
  );
  const button = {
    padding: "6px 14px",
    borderRadius: 6,
    border: "1px solid #555",
    background: "#222",
    color: "inherit",
    cursor: "pointer",
    font: "inherit",
  } as const;
  return (
    <div
      role="alert"
      style={{
        minHeight: "100vh",
        padding: 24,
        background: "#0d0f14",
        color: "#e6e6e6",
        font: "14px/1.5 system-ui, sans-serif",
      }}
    >
      <h1 style={{ fontSize: 18, margin: "0 0 8px" }}>Postbox hit an error</h1>
      <p style={{ margin: "0 0 12px", color: "#aaa" }}>
        Nothing saved on the server is affected. Try again, or reload the page. If it keeps happening, copy
        the details below into a bug report.
      </p>
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <button style={button} onClick={reset}>
          Try again
        </button>
        <button style={button} onClick={() => location.reload()}>
          Reload
        </button>
        <button
          style={button}
          onClick={async () => {
            setCopied(await copyText(details));
            setTimeout(() => setCopied(false), 2000);
          }}
        >
          {copied ? "Copied" : "Copy details"}
        </button>
      </div>
      <pre
        style={{
          margin: 0,
          padding: 12,
          overflow: "auto",
          maxHeight: "60vh",
          background: "#161a22",
          borderRadius: 6,
          fontSize: 12,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {details}
      </pre>
    </div>
  );
}
