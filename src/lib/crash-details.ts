/** Plain-text details of an uncaught UI error, for the crash screen and bug reports. */
export function formatCrashDetails(
  error: unknown,
  context: { url?: string; userAgent?: string; version?: string } = {},
): string {
  const err = error as { name?: unknown; message?: unknown; stack?: unknown; digest?: unknown } | null;
  const text = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  const lines = [
    `Error: ${text(err?.name) ?? "Error"}: ${text(err?.message) ?? (typeof error === "string" ? error : "unknown error")}`,
  ];
  const digest = text(err?.digest);
  if (digest) lines.push(`Digest: ${digest}`);
  if (context.url) lines.push(`Page: ${context.url}`);
  if (context.userAgent) lines.push(`Browser: ${context.userAgent}`);
  const stack = text(err?.stack);
  if (stack) lines.push("", stack.split("\n").slice(0, 25).join("\n"));
  return lines.join("\n");
}
