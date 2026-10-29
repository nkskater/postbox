"use client";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useDialogs } from "@/stores/dialogs";

export const SHORTCUTS: [string, string][] = [
  ["Ctrl/⌘ + Enter", "Send request"],
  ["Ctrl/⌘ + S", "Save request / folder / environment"],
  ["Ctrl/⌘ + K", "Command palette"],
  ["Ctrl/⌘ + ,", "Open settings"],
  ["Ctrl/⌘ + B", "Toggle sidebar"],
  ["Ctrl/⌘ + `", "Toggle console"],
  ["Alt + T", "New request tab"],
  ["Alt + W", "Close tab"],
  ["Alt + 1…9", "Jump to tab"],
  ["Ctrl/⌘ + F", "Search inside an editor or response"],
  ["Ctrl/⌘ + Space", "Variable autocomplete (after typing {{)"],
  ["?", "Show this help"],
];

export function ShortcutsDialog() {
  const open = useDialogs((s) => s.shortcutsOpen);
  const setOpen = useDialogs((s) => s.setShortcutsOpen);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
        </DialogHeader>
        <table className="w-full text-sm">
          <tbody>
            {SHORTCUTS.map(([k, v]) => (
              <tr key={k} className="border-b last:border-0">
                <td className="py-1.5">
                  <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs">{k}</kbd>
                </td>
                <td className="py-1.5 text-muted-foreground">{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </DialogContent>
    </Dialog>
  );
}
