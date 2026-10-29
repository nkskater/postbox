"use client";
/* eslint-disable react-hooks/refs -- refs are only read inside CodeMirror event callbacks, never during render */
/**
 * Single-line input with {{variable}} highlighting, hover values and completion.
 * Built on CodeMirror so highlighting stays aligned with the caret.
 */
import { useLayoutEffect, useMemo, useRef } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { EditorState, Prec, type Extension } from "@codemirror/state";
import { EditorView, keymap, placeholder as placeholderExt } from "@codemirror/view";
import { useApp } from "@/stores/app";
import { cn } from "@/lib/utils";
import { variableExtensions } from "./variables-ext";
import { editorTheme } from "./theme";

const singleLine: Extension = [
  // Strip newlines from typed or pasted text.
  EditorState.transactionFilter.of((tr) => (tr.newDoc.lines > 1 ? [] : tr)),
  EditorView.theme({
    "&": { fontSize: "13px" },
    ".cm-content": { padding: "0", fontFamily: "var(--font-mono)" },
    ".cm-line": { padding: "0 8px" },
    ".cm-scroller": { overflow: "hidden" },
  }),
];

export interface VarInputProps {
  value: string;
  onChange: (value: string) => void;
  onEnter?: () => void;
  placeholder?: string;
  className?: string;
  readOnly?: boolean;
  /** Show the value as dots (secret fields). */
  masked?: boolean;
  autoFocus?: boolean;
  onPasteText?: (text: string) => boolean;
}

export function VarInput({
  value,
  onChange,
  onEnter,
  placeholder,
  className,
  readOnly,
  masked,
  autoFocus,
  onPasteText,
}: VarInputProps) {
  const theme = useApp((s) => s.theme);
  const vars = useApp((s) => s.variables);
  // Callbacks live in refs so the CodeMirror extensions don't have to be rebuilt every render.
  const enterRef = useRef(onEnter);
  const pasteRef = useRef(onPasteText);
  useLayoutEffect(() => {
    enterRef.current = onEnter;
    pasteRef.current = onPasteText;
  });
  const hasEnter = !!onEnter;
  const hasPaste = !!onPasteText;
  const extensions = useMemo(() => {
    const exts: Extension[] = [singleLine, ...variableExtensions(vars)];
    if (placeholder) exts.push(placeholderExt(placeholder));
    if (hasEnter)
      exts.push(Prec.highest(keymap.of([{ key: "Enter", run: () => (enterRef.current?.(), true) }])));
    if (masked) exts.push(EditorView.contentAttributes.of({ style: "-webkit-text-security: disc" }));
    if (hasPaste)
      exts.push(
        EditorView.domEventHandlers({
          paste: (e) => {
            const text = e.clipboardData?.getData("text/plain") ?? "";
            if (pasteRef.current?.(text)) {
              e.preventDefault();
              return true;
            }
            return false;
          },
        }),
      );
    return exts;
  }, [vars, placeholder, hasEnter, masked, hasPaste]);

  return (
    <div
      className={cn(
        "flex h-8 min-w-0 items-center rounded-md border border-input bg-transparent focus-within:ring-2 focus-within:ring-ring/50",
        className,
      )}
    >
      <CodeMirror
        value={value}
        onChange={(v) => onChange(v.replace(/\r?\n/g, " "))}
        readOnly={readOnly}
        autoFocus={autoFocus}
        theme={editorTheme(theme)}
        extensions={extensions}
        className="w-full min-w-0 [&_.cm-editor]:bg-transparent"
        basicSetup={{
          lineNumbers: false,
          foldGutter: false,
          highlightActiveLine: false,
          highlightActiveLineGutter: false,
          autocompletion: false,
          searchKeymap: false,
          history: true,
        }}
      />
    </div>
  );
}
