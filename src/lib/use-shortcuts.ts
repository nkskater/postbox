"use client";
/** React and non-React access to the current keyboard bindings. */
import { useMemo, useSyncExternalStore } from "react";
import { getSetting } from "@/lib/settings/runtime";
import { useSetting } from "@/stores/settings";
import { formatCombo, resolveBindings, type Bindings, type ShortcutId } from "@/lib/shortcuts";

export const SHORTCUT_SETTING = "keys.bindings";

/** The bindings right now, for event handlers (always current, no re-render needed). */
export const currentBindings = (): Bindings => resolveBindings(getSetting(SHORTCUT_SETTING));

export function useBindings(): Bindings {
  const raw = useSetting<string>(SHORTCUT_SETTING);
  return useMemo(() => resolveBindings(raw), [raw]);
}

/** ⌘-style text on macOS; false on the server render so hydration matches. */
export function useIsMac(): boolean {
  return useSyncExternalStore(
    () => () => undefined,
    () => /Mac|iPhone|iPad/.test(navigator.platform),
    () => false,
  );
}

/** Display text for one action, such as "Ctrl+Enter", following the user's bindings. */
export function useShortcutLabel(id: ShortcutId): string {
  const bindings = useBindings();
  return formatCombo(bindings[id], useIsMac());
}
