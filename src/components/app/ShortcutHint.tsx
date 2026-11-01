"use client";
import type { ShortcutId } from "@/lib/shortcuts";
import { useShortcutLabel } from "@/lib/use-shortcuts";

/** Inline text for an action's current shortcut, for hints that are not attributes. */
export function ShortcutHint({ id }: { id: ShortcutId }) {
  return <>{useShortcutLabel(id)}</>;
}
