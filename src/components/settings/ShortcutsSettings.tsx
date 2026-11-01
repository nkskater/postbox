"use client";
/** Keyboard shortcuts: change, clear and reset the keys for common actions. */
import { useEffect, useState } from "react";
import { Keyboard, RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSettings } from "@/stores/settings";
import {
  FIXED_SHORTCUTS,
  SHORTCUT_ACTIONS,
  comboFromEvent,
  formatCombo,
  serializeOverrides,
  validateCombo,
  type Bindings,
  type ShortcutId,
} from "@/lib/shortcuts";
import { SHORTCUT_SETTING, useBindings, useIsMac } from "@/lib/use-shortcuts";

const save = (bindings: Bindings) =>
  void useSettings.getState().set(SHORTCUT_SETTING, serializeOverrides(bindings));

export function ShortcutsSettings() {
  const bindings = useBindings();
  const mac = useIsMac();
  const [capturing, setCapturing] = useState<ShortcutId | null>(null);
  const [problem, setProblem] = useState<{ id: ShortcutId; message: string } | null>(null);

  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      // Take the key for ourselves so it does not also run the action it is currently bound to.
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") return setCapturing(null);
      const combo = comboFromEvent(e);
      if (!combo) return; // a modifier on its own: wait for the key
      const check = validateCombo(capturing, combo, bindings);
      setCapturing(null);
      if (check.ok) {
        setProblem(null);
        save({ ...bindings, [capturing]: combo });
      } else setProblem({ id: capturing, message: check.reason });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [capturing, bindings]);

  const kbd = "rounded border bg-muted px-1.5 py-0.5 font-mono text-xs";
  return (
    <div className="space-y-4">
      <div className="divide-y rounded-lg border text-sm" role="table" aria-label="Keyboard shortcuts">
        {SHORTCUT_ACTIONS.map((action) => {
          const current = bindings[action.id];
          const changed = current !== action.default;
          const active = capturing === action.id;
          return (
            <div key={action.id} role="row" className="flex flex-wrap items-center gap-3 px-4 py-2.5">
              <div className="min-w-40 flex-1">
                <div>{action.label}</div>
                {problem?.id === action.id && (
                  <div role="alert" className="text-xs text-destructive">
                    {problem.message}
                  </div>
                )}
              </div>
              {active ? (
                <span className="text-xs text-muted-foreground" role="status">
                  Press the new keys… (Esc to cancel)
                </span>
              ) : (
                <kbd className={kbd}>{formatCombo(current, mac)}</kbd>
              )}
              <Button
                size="sm"
                variant="outline"
                className="h-7"
                aria-label={`Change shortcut for ${action.label}`}
                disabled={!!capturing && !active}
                onClick={() => {
                  setProblem(null);
                  setCapturing(active ? null : action.id);
                }}
              >
                <Keyboard className="size-3.5" /> {active ? "Cancel" : "Change"}
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="size-7"
                title="Clear (no shortcut)"
                aria-label={`Clear shortcut for ${action.label}`}
                disabled={current === null || !!capturing}
                onClick={() => {
                  setProblem(null);
                  save({ ...bindings, [action.id]: null });
                }}
              >
                <X className="size-3.5" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="size-7"
                title={`Reset to ${formatCombo(action.default, mac)}`}
                aria-label={`Reset shortcut for ${action.label}`}
                disabled={!changed || !!capturing}
                onClick={() => {
                  const next = { ...bindings, [action.id]: action.default };
                  const check = validateCombo(action.id, action.default, { ...bindings, [action.id]: null });
                  if (!check.ok && check.conflictWith) {
                    // The default is taken by an action the user moved there: free it first.
                    next[check.conflictWith] = null;
                  }
                  setProblem(null);
                  save(next);
                }}
              >
                <RotateCcw className="size-3.5" />
              </Button>
            </div>
          );
        })}
      </div>
      <div>
        <h3 className="mb-1 text-sm font-medium">Built in</h3>
        <div className="divide-y rounded-lg border text-sm">
          {FIXED_SHORTCUTS.map((f) => (
            <div key={f.label} className="flex items-center gap-3 px-4 py-2 text-muted-foreground">
              <span className="flex-1">{f.label}</span>
              <kbd className={kbd}>{formatCombo(f.combo, mac)}</kbd>
            </div>
          ))}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Use Ctrl/⌘ or Alt with a key. Combinations the browser keeps (such as Ctrl+T and Ctrl+W) can&apos;t be
        used. Use Reset section above to restore every default.
      </p>
    </div>
  );
}
