"use client";
/**
 * Multi-line code editor (CodeMirror 6) with language support, folding,
 * search (Ctrl+F) and {{variable}} highlighting.
 */
import { useMemo } from "react";
import CodeMirror, { type ReactCodeMirrorProps } from "@uiw/react-codemirror";
import { json } from "@codemirror/lang-json";
import { xml } from "@codemirror/lang-xml";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { useApp } from "@/stores/app";
import { variableExtensions } from "./variables-ext";
import { editorTheme } from "./theme";

export type EditorLanguage = "json" | "xml" | "html" | "javascript" | "text" | "graphql";

const languageExt = (lang: EditorLanguage): Extension[] => {
  switch (lang) {
    case "json":
      return [json()];
    case "xml":
      return [xml()];
    case "html":
      return [html()];
    case "javascript":
      return [javascript()];
    default:
      return [];
  }
};

export interface CodeEditorProps {
  value: string;
  onChange?: (value: string) => void;
  language?: EditorLanguage;
  readOnly?: boolean;
  /** Highlight {{variables}} (default true unless read-only). */
  variables?: boolean;
  wrap?: boolean;
  placeholder?: string;
  className?: string;
  extensions?: Extension[];
  basicSetup?: ReactCodeMirrorProps["basicSetup"];
}

export function CodeEditor({
  value,
  onChange,
  language = "text",
  readOnly,
  variables,
  wrap,
  placeholder,
  className,
  extensions: extra,
  basicSetup,
}: CodeEditorProps) {
  const theme = useApp((s) => s.theme);
  const vars = useApp((s) => s.variables);
  const highlightVars = variables ?? !readOnly;
  const extensions = useMemo(
    () => [
      ...languageExt(language),
      ...(highlightVars ? variableExtensions(vars, { autocomplete: !readOnly }) : []),
      ...(wrap ? [EditorView.lineWrapping] : []),
      ...(extra ?? []),
    ],
    [language, highlightVars, vars, readOnly, wrap, extra],
  );
  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      readOnly={readOnly}
      editable={!readOnly}
      placeholder={placeholder}
      theme={editorTheme(theme)}
      extensions={extensions}
      height="100%"
      className={className ?? "h-full"}
      basicSetup={{
        lineNumbers: true,
        foldGutter: true,
        highlightActiveLine: !readOnly,
        highlightActiveLineGutter: !readOnly,
        autocompletion: false,
        searchKeymap: true,
        ...(typeof basicSetup === "object" ? basicSetup : {}),
      }}
    />
  );
}
