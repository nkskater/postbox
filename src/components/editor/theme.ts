/**
 * CodeMirror themes derived from the app's CSS variables.
 */
import { EditorView } from "@codemirror/view";
import { githubDark, githubLight } from "@uiw/codemirror-theme-github";

const base = EditorView.theme({
  "&": { backgroundColor: "transparent", color: "var(--foreground)" },
  ".cm-gutters": {
    backgroundColor: "transparent",
    borderRight: "1px solid var(--border)",
    color: "var(--muted-foreground)",
  },
  ".cm-activeLine, .cm-activeLineGutter": {
    backgroundColor: "color-mix(in oklch, var(--accent) 50%, transparent)",
  },
  ".cm-tooltip": {
    backgroundColor: "var(--popover)",
    color: "var(--popover-foreground)",
    border: "1px solid var(--border)",
    borderRadius: "6px",
  },
  ".pb-var-tooltip": {
    padding: "4px 8px",
    fontFamily: "var(--font-mono)",
    fontSize: "12px",
    maxWidth: "480px",
    wordBreak: "break-all",
  },
  ".cm-panels": { backgroundColor: "var(--card)", color: "var(--foreground)" },
  ".cm-searchMatch": { backgroundColor: "color-mix(in oklch, var(--warning) 35%, transparent)" },
  ".cm-foldPlaceholder": {
    backgroundColor: "var(--muted)",
    border: "none",
    color: "var(--muted-foreground)",
  },
});

export const editorTheme = (mode: "dark" | "light") => [mode === "dark" ? githubDark : githubLight, base];
