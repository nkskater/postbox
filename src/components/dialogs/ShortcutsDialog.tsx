"use client";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useDialogs } from "@/stores/dialogs";
import { FIXED_SHORTCUTS, SHORTCUT_ACTIONS, formatCombo } from "@/lib/shortcuts";
import { useBindings, useIsMac } from "@/lib/use-shortcuts";

export function ShortcutsDialog() {
  const open = useDialogs((s) => s.shortcutsOpen);
  const setOpen = useDialogs((s) => s.setShortcutsOpen);
  const bindings = useBindings();
  const mac = useIsMac();
  const rows: [string, string][] = [
    ...SHORTCUT_ACTIONS.map((a): [string, string] => [formatCombo(bindings[a.id], mac), a.label]),
    ...FIXED_SHORTCUTS.map((f): [string, string] => [formatCombo(f.combo, mac), f.label]),
  ];
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
        </DialogHeader>
        <table className="w-full text-sm">
          <tbody>
            {rows.map(([k, v]) => (
              <tr key={v} className="border-b last:border-0">
                <td className="py-1.5">
                  <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs">{k}</kbd>
                </td>
                <td className="py-1.5 text-muted-foreground">{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-xs text-muted-foreground">Change these under Settings → Keyboard shortcuts.</p>
      </DialogContent>
    </Dialog>
  );
}
