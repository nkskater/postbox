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
import { EditorState, type Extension } from "@codemirror/state";
import { indentUnit } from "@codemirror/language";
import { useApp } from "@/stores/app";
import { useSetting } from "@/stores/settings";
import { useVariableOptions, variableExtensions } from "./variables-ext";
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
  /** Wrap long lines; defaults to the editor.wrap setting. */
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
  const varOpts = useVariableOptions();
  const wrapDefault = useSetting<boolean>("editor.wrap");
  const lineNumbers = useSetting<boolean>("editor.lineNumbers");
  const folding = useSetting<boolean>("editor.folding");
  const brackets = useSetting<boolean>("editor.brackets");
  const activeLine = useSetting<boolean>("editor.activeLine");
  const tabSize = Number(useSetting<string>("editor.tabSize")) || 2;
  const highlightVars = variables ?? !readOnly;
  const lineWrap = wrap ?? wrapDefault;
  const extensions = useMemo(
    () => [
      ...languageExt(language),
      ...(highlightVars
        ? variableExtensions(vars, { ...varOpts, autocomplete: !readOnly && varOpts.autocomplete })
        : []),
      ...(lineWrap ? [EditorView.lineWrapping] : []),
      EditorState.tabSize.of(tabSize),
      indentUnit.of(" ".repeat(tabSize)),
      ...(extra ?? []),
    ],
    [language, highlightVars, vars, varOpts, readOnly, lineWrap, tabSize, extra],
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
        lineNumbers,
        foldGutter: folding,
        bracketMatching: brackets,
        closeBrackets: brackets && !readOnly,
        highlightActiveLine: !readOnly && activeLine,
        highlightActiveLineGutter: !readOnly && activeLine,
        autocompletion: false,
        searchKeymap: true,
        ...(typeof basicSetup === "object" ? basicSetup : {}),
      }}
    />
  );
}
