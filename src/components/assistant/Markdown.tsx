"use client";
/**
 * Renders assistant replies (untrusted model output) as Markdown. Output is React elements only:
 * raw HTML in the text is shown as text, links are limited to http, https and mailto and open in a
 * new tab, and images are never loaded (their alt text is shown instead). Incomplete Markdown, as
 * it arrives while a reply streams, renders as far as it parses.
 */
import { useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

const SAFE_LINK = /^(https?:|mailto:)/i;

/** Only absolute http(s) and mailto links survive; everything else (javascript:, data:, relative) is dropped. */
export function safeUrl(url: string): string {
  return SAFE_LINK.test(url.trim()) ? url : "";
}

function CodeBlock({ children, language }: { children: ReactNode; language?: string }) {
  const [copied, setCopied] = useState(false);
  const text = String(children).replace(/\n$/, "");
  return (
    <div className="group relative my-2 min-w-0 rounded border bg-muted/40">
      <div className="flex items-center justify-between border-b px-2 py-0.5 text-[10px] text-muted-foreground">
        <span>{language ?? "code"}</span>
        <button
          type="button"
          className="flex items-center gap-1 hover:text-foreground"
          aria-label="Copy code"
          onClick={() => {
            void navigator.clipboard?.writeText(text).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="max-w-full overflow-x-auto p-2 font-mono text-[11px] leading-relaxed">
        <code>{text}</code>
      </pre>
    </div>
  );
}

const components: Components = {
  h1: ({ children }) => <h3 className="mt-3 mb-1 text-sm font-semibold">{children}</h3>,
  h2: ({ children }) => <h3 className="mt-3 mb-1 text-sm font-semibold">{children}</h3>,
  h3: ({ children }) => <h4 className="mt-2 mb-1 text-xs font-semibold">{children}</h4>,
  h4: ({ children }) => <h5 className="mt-2 mb-1 text-xs font-semibold">{children}</h5>,
  h5: ({ children }) => <h6 className="mt-2 mb-1 text-xs font-medium">{children}</h6>,
  h6: ({ children }) => <h6 className="mt-2 mb-1 text-xs font-medium">{children}</h6>,
  p: ({ children }) => <p className="my-1.5 leading-relaxed">{children}</p>,
  ul: ({ children }) => <ul className="my-1.5 list-disc space-y-0.5 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-1.5 list-decimal space-y-0.5 pl-5">{children}</ol>,
  li: ({ children }) => <li className="[&>ol]:my-0.5 [&>ul]:my-0.5">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 pl-3 text-muted-foreground">{children}</blockquote>
  ),
  hr: () => <hr className="my-3 border-border" />,
  a: ({ href, children }) =>
    href ? (
      <a href={href} target="_blank" rel="noopener noreferrer" className="break-all text-primary underline">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  // Remote images are never loaded; show what they were.
  img: ({ alt }) => <span className="text-muted-foreground">[image{alt ? `: ${alt}` : ""}]</span>,
  table: ({ children }) => (
    <div className="my-2 max-w-full overflow-x-auto">
      <table className="w-max border-collapse text-[11px]">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border bg-muted/40 px-2 py-1 text-left font-medium">{children}</th>,
  td: ({ children }) => <td className="border px-2 py-1 align-top">{children}</td>,
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children }) => {
    const language = /language-([\w+-]+)/.exec(className ?? "")?.[1];
    const block = !!language || String(children).includes("\n");
    return block ? (
      <CodeBlock language={language}>{children}</CodeBlock>
    ) : (
      <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.95em] break-words">{children}</code>
    );
  },
};

export function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn("min-w-0 text-xs break-words [overflow-wrap:anywhere]", className)} data-markdown>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={components}
        urlTransform={safeUrl}
        skipHtml={false}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
