/**
 * Copy text to the clipboard. `navigator.clipboard` only exists in secure contexts (HTTPS or
 * localhost), and Postbox is often served over plain HTTP on a LAN, so fall back to a hidden
 * textarea and `document.execCommand("copy")`. Resolves to whether the copy succeeded.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Permission denied or no focus: try the fallback below.
  }
  if (typeof document === "undefined") return false;
  const previous = document.activeElement as HTMLElement | null;
  // Inside a modal dialog the textarea must live in the dialog or its focus trap steals focus.
  const host = previous?.closest?.('[role="dialog"]') ?? document.body;
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.setAttribute("aria-hidden", "true");
  area.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none";
  host.appendChild(area);
  try {
    area.focus();
    area.select();
    area.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
    previous?.focus?.();
  }
}
