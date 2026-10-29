/**
 * Two-way sync between the URL bar and the Params table.
 * Works on raw strings (no percent-encoding) so {{variables}} survive untouched.
 */
import type { KeyValue } from "@/core/types";

export function splitUrl(url: string): { base: string; query: string; hash: string } {
  const hashIdx = url.indexOf("#");
  const hash = hashIdx >= 0 ? url.slice(hashIdx) : "";
  const noHash = hashIdx >= 0 ? url.slice(0, hashIdx) : url;
  const qIdx = noHash.indexOf("?");
  return qIdx >= 0
    ? { base: noHash.slice(0, qIdx), query: noHash.slice(qIdx + 1), hash }
    : { base: noHash, query: "", hash };
}

/** Parse the URL query; disabled params from `previous` are kept in place. */
export function paramsFromUrl(url: string, previous: KeyValue[] = []): KeyValue[] {
  const { query } = splitUrl(url);
  const enabled: KeyValue[] = query
    ? query.split("&").map((pair) => {
        const i = pair.indexOf("=");
        return i >= 0
          ? { key: pair.slice(0, i), value: pair.slice(i + 1), enabled: true }
          : { key: pair, value: "", enabled: true };
      })
    : [];
  // Re-attach descriptions by position for matching keys.
  const prevEnabled = previous.filter((p) => p.enabled);
  enabled.forEach((p, i) => {
    if (prevEnabled[i]?.key === p.key) p.description = prevEnabled[i].description;
  });
  const disabled = previous.filter((p) => !p.enabled);
  return [...enabled, ...disabled];
}

export function urlWithParams(url: string, params: KeyValue[]): string {
  const { base, hash } = splitUrl(url);
  const query = params
    .filter((p) => p.enabled && (p.key || p.value))
    .map((p) => (p.value !== "" || p.key.endsWith("=") ? `${p.key}=${p.value}` : p.key))
    .join("&");
  return `${base}${query ? `?${query}` : ""}${hash}`;
}
