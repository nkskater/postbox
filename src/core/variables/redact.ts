/** Secret redaction, kept free of the template resolver (and its fake-data generator) for the browser. */

/**
 * Redact the values of secret variables from free text (logs, console output).
 * Very short values are skipped to avoid redacting common substrings.
 */
export const REDACTION_MASK = "********";

export function redactSecrets(text: string, secrets: Iterable<string>): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 3) out = out.split(secret).join(REDACTION_MASK);
  }
  return out;
}

/**
 * Redact structured persistence payloads without serializing secrets into JSON first.
 * With `keepReferences`, text inside {{variable}} references is left alone: a short secret that happens to
 * occur in a variable name must not turn the reference into a different, unresolvable one.
 */
export function redactStoredValue<T>(
  value: T,
  secrets: Iterable<string>,
  options: { mask?: string; keepReferences?: boolean } = {},
): T {
  const mask = options.mask ?? "********";
  const patterns = [
    ...new Set(
      [...secrets].filter(Boolean).flatMap((secret) => {
        let encoded = secret;
        try {
          encoded = encodeURIComponent(secret);
        } catch {
          /* preserve malformed Unicode literally */
        }
        return [
          secret,
          encoded,
          encoded.replace(/%[0-9A-F]{2}/g, (match) => match.toLowerCase()),
          encoded.replace(/%20/g, "+"),
          JSON.stringify(secret).slice(1, -1),
        ];
      }),
    ),
  ].sort((a, b) => b.length - a.length);
  const matcher = patterns.length
    ? new RegExp(patterns.map((pattern) => pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g")
    : undefined;
  const scrub = (input: unknown): unknown => {
    if (typeof input === "string") {
      if (!matcher) return input;
      if (!options.keepReferences) return input.replace(matcher, mask);
      return input
        .split(/(\{\{[^{}]*\}\})/)
        .map((part, index) => (index % 2 ? part : part.replace(matcher, mask)))
        .join("");
    }
    if (Array.isArray(input)) return input.map(scrub);
    if (input && typeof input === "object")
      return Object.fromEntries(Object.entries(input).map(([key, entry]) => [key, scrub(entry)]));
    return input;
  };
  return scrub(value) as T;
}
