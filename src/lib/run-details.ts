import { formatXml } from "./format";

export function prettyRecordedBody(text: string, contentType: string): string {
  try {
    if (contentType.includes("json") || /^[\s]*[\[{]/.test(text))
      return JSON.stringify(JSON.parse(text), null, 2);
    if (contentType.includes("xml")) return formatXml(text);
  } catch {
    /* Malformed structured bodies remain readable as raw text. */
  }
  return text;
}
