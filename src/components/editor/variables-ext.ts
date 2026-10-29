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
import { autocompletion, type CompletionContext } from "@codemirror/autocomplete";
import type { Extension } from "@codemirror/state";
import { DYNAMIC_VARIABLES } from "@/core/variables/dynamic";
import type { KnownVariable } from "@/stores/app";

const PATTERN = /\{\{\s*([^{}]+?)\s*\}\}/g;

export function variableExtensions(
  vars: Record<string, KnownVariable>,
  opts: { autocomplete?: boolean } = {},
): Extension[] {
  const known = (name: string) => name in vars || name in DYNAMIC_VARIABLES;
  const decorator = new MatchDecorator({
    regexp: PATTERN,
    decoration: (m) => Decoration.mark({ class: known(m[1].trim()) ? "pb-var-ok" : "pb-var-missing" }),
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
          else if (name in DYNAMIC_VARIABLES)
            dom.textContent = `${name}: dynamic variable (generated per request)`;
          else dom.textContent = `${name} is not defined in the active environment, collection or globals`;
          return { dom };
        },
      };
    }
    return null;
  });

  const exts: Extension[] = [plugin, tooltip];
  if (opts.autocomplete !== false) {
    const source = (ctx: CompletionContext) => {
      const before = ctx.matchBefore(/\{\{[^{}]*$/);
      if (!before) return null;
      const options = [
        ...Object.entries(vars).map(([label, v]) => ({
          label,
          detail: v.scope,
          info: v.secret ? "secret" : v.value,
          apply: `${label}}}`,
        })),
        ...Object.keys(DYNAMIC_VARIABLES).map((label) => ({ label, detail: "dynamic", apply: `${label}}}` })),
      ];
      return { from: before.from + 2, options, validFor: /^[^{}]*$/ };
    };
    exts.push(autocompletion({ override: [source], icons: false }));
  }
  return exts;
}
