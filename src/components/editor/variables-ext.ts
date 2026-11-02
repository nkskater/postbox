/**
 * CodeMirror extensions for {{variable}} support: highlighting (resolved vs.
 * unresolved), hover tooltip with the current value, and autocompletion.
 */
import {
  Decoration,
  EditorView,
  MatchDecorator,
  ViewPlugin,
  hoverTooltip,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import {
  autocompletion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from "@codemirror/autocomplete";
import type { Extension } from "@codemirror/state";
import { DYNAMIC_VARIABLE_NAMES, isDynamicVariable } from "@/core/variables/dynamic-catalog";
import { useMemo } from "react";
import type { KnownVariable } from "@/stores/app";
import { useSetting } from "@/stores/settings";

const PATTERN = /\{\{\s*([^{}]+?)\s*\}\}/g;

export interface VariableExtOptions {
  autocomplete?: boolean;
  /** Underline variables that are not defined (default true). */
  highlightUnresolved?: boolean;
  /** Show the current value on hover (default true). */
  tooltips?: boolean;
}

/** Variable-related editor options from the user's settings. */
export function useVariableOptions(): Required<VariableExtOptions> {
  const autocomplete = useSetting<boolean>("editor.variableAutocomplete");
  const highlightUnresolved = useSetting<boolean>("editor.highlightUnresolved");
  const tooltips = useSetting<boolean>("variables.tooltips");
  return useMemo(
    () => ({ autocomplete, highlightUnresolved, tooltips }),
    [autocomplete, highlightUnresolved, tooltips],
  );
}

export function variableExtensions(
  vars: Record<string, KnownVariable>,
  opts: VariableExtOptions = {},
): Extension[] {
  // {{vault:name}} is resolved on the server, so the browser cannot tell whether the secret exists; it is not flagged.
  const known = (name: string) => name in vars || isDynamicVariable(name) || name.startsWith("vault:");
  const missingClass = opts.highlightUnresolved === false ? "pb-var-ok" : "pb-var-missing";
  const decorator = new MatchDecorator({
    regexp: PATTERN,
    decoration: (m) => Decoration.mark({ class: known(m[1].trim()) ? "pb-var-ok" : missingClass }),
  });
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = decorator.createDeco(view);
      }
      update(u: ViewUpdate) {
        this.decorations = decorator.updateDeco(u, this.decorations);
      }
    },
    { decorations: (v) => v.decorations },
  );

  const tooltip = hoverTooltip((view, pos) => {
    const line = view.state.doc.lineAt(pos);
    for (const m of line.text.matchAll(PATTERN)) {
      const from = line.from + m.index!;
      const to = from + m[0].length;
      if (pos < from || pos > to) continue;
      const name = m[1].trim();
      return {
        pos: from,
        end: to,
        above: true,
        create() {
          const dom = document.createElement("div");
          dom.className = "pb-var-tooltip";
          const v = vars[name];
          if (v) dom.textContent = `${name} = ${v.secret ? "••••••••" : v.value || "(empty)"}   [${v.scope}]`;
          else if (name.startsWith("vault:"))
            dom.textContent = `${name.slice(6)}: secrets vault reference (resolved only when the request is sent)`;
          else if (isDynamicVariable(name))
            dom.textContent = `${name}: dynamic variable (generated per request)`;
          else dom.textContent = `${name} is not defined in the active environment, collection or globals`;
          return { dom };
        },
      };
    }
    return null;
  });

  const exts: Extension[] = opts.tooltips === false ? [plugin] : [plugin, tooltip];
  if (opts.autocomplete !== false) {
    exts.push(
      autocompletion({ override: [variableCompletionSource(vars), languageCompletionSource], icons: false }),
    );
  }
  return exts;
}

/**
 * `override` replaces the language's own completion sources, so delegate to them
 * here (GraphQL fields, for example); the first source with a result wins.
 */
async function languageCompletionSource(ctx: CompletionContext): Promise<CompletionResult | null> {
  for (const source of ctx.state.languageDataAt<CompletionSource>("autocomplete", ctx.pos)) {
    const result = await source(ctx);
    if (result) return result;
  }
  return null;
}

export function variableCompletionSource(vars: Record<string, KnownVariable>) {
  return (ctx: CompletionContext) => {
    const before = ctx.matchBefore(/\{\{[^{}]*$/);
    if (!before) return null;
    const options = [
      ...Object.entries(vars).map(([label, v]) => ({
        label,
        detail: v.scope,
        info: v.secret ? "secret" : v.value,
        apply: `${label}}}`,
      })),
      ...DYNAMIC_VARIABLE_NAMES.map((label) => ({ label, detail: "dynamic", apply: `${label}}}` })),
    ];
    return { from: before.from + 2, options, validFor: /^[^{}]*$/ };
  };
}
