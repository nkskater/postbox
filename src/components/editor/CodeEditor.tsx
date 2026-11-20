"use client";
/**
 * Multi-line code editor (CodeMirror 6) with language support, folding,
 * search (Ctrl+F) and {{variable}} highlighting.
 */
import { useEffect, useMemo, useState } from "react";
import CodeMirror, { type ReactCodeMirrorProps } from "@uiw/react-codemirror";
import { json } from "@codemirror/lang-json";
import { EditorView } from "@codemirror/view";
import { EditorState, type Extension } from "@codemirror/state";
import { indentUnit } from "@codemirror/language";
import { useApp } from "@/stores/app";
import { useSetting } from "@/stores/settings";
import { useVariableOptions, variableExtensions } from "./variables-ext";
import { editorTheme } from "./theme";

export type EditorLanguage = "json" | "xml" | "html" | "javascript" | "text" | "graphql";

// JSON is highlighted from the first paint; the other language packs load the first time an
// editor needs them (HTML brings CSS and JavaScript with it), and are then shared by every editor.
const loaded = new Map<EditorLanguage, Extension[]>([
  ["json", [json()]],
  ["text", []],
  ["graphql", []],
]);
const loaders: Partial<Record<EditorLanguage, () => Promise<Extension[]>>> = {
  xml: () => import("@codemirror/lang-xml").then((m) => [m.xml()]),
  html: () => import("@codemirror/lang-html").then((m) => [m.html()]),
  javascript: () => import("@codemirror/lang-javascript").then((m) => [m.javascript()]),
};
const pending = new Map<EditorLanguage, Promise<Extension[]>>();

function useLanguage(lang: EditorLanguage): Extension[] {
  const [, setReady] = useState(0);
  useEffect(() => {
    if (loaded.has(lang)) return;
    let live = true;
    let load = pending.get(lang);
    if (!load) {
      load = (loaders[lang]?.() ?? Promise.resolve([])).then((ext) => {
        loaded.set(lang, ext);
        return ext;
      });
      pending.set(lang, load);
    }
    load.then(
      () => live && setReady((n) => n + 1),
      () => pending.delete(lang),
    );
    return () => {
      live = false;
    };
  }, [lang]);
  return loaded.get(lang) ?? [];
}

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
  const languageExt = useLanguage(language);
  const lineWrap = wrap ?? wrapDefault;
  const extensions = useMemo(
    () => [
      ...languageExt,
      ...(highlightVars
        ? variableExtensions(vars, { ...varOpts, autocomplete: !readOnly && varOpts.autocomplete })
        : []),
      ...(lineWrap ? [EditorView.lineWrapping] : []),
      EditorState.tabSize.of(tabSize),
      indentUnit.of(" ".repeat(tabSize)),
      ...(extra ?? []),
    ],
    [languageExt, highlightVars, vars, varOpts, readOnly, lineWrap, tabSize, extra],
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
