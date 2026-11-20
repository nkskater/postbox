/**
 * Validates saved examples against the full response-example schema. Separate from ./examples so
 * the browser's request editor does not load the schema module (and its JSON Schema validator).
 */
import type { ResponseExample } from "./types";
import { responseExampleSchema } from "./schemas";
import { base64ByteLength, MAX_UPLOAD_BYTES } from "./retention";
import { MAX_EXAMPLES } from "./examples";

export function validateExamples(input: ResponseExample[]): ResponseExample[] {
  if (input.length > MAX_EXAMPLES) throw new Error(`A request supports at most ${MAX_EXAMPLES} examples`);
  const ids = new Set<string>();
  let bytes = 0;
  const encoder = new TextEncoder();
  return input.map((raw) => {
    const example = responseExampleSchema.parse(raw);
    if (ids.has(example.id)) throw new Error("Example IDs must be unique within a request");
    ids.add(example.id);
    const bodyBytes =
      example.bodyEncoding === "base64"
        ? base64ByteLength(example.body)
        : encoder.encode(example.body).byteLength;
    if (
      example.bodyEncoding === "base64" &&
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(example.body)
    )
      throw new Error("Example body must be valid base64");
    if (bodyBytes > MAX_UPLOAD_BYTES) throw new Error("Example response body exceeds 5 MiB");
    bytes += encoder.encode(JSON.stringify(example)).byteLength;
    if (bytes > 20 * 1024 * 1024) throw new Error("Saved example content exceeds 20 MiB per request");
    return example;
  });
}
