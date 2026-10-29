/** Read NDJSON across arbitrary UTF-8/network boundaries, releasing the reader on exit. */
export async function* readNdjson(
  stream: ReadableStream<Uint8Array>,
  maxLineChars = 8 * 1024 * 1024,
): AsyncGenerator<unknown> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let complete = false;
  const parse = (line: string): unknown => {
    if (line.length > maxLineChars) throw new Error("Runner event exceeds the size limit");
    return JSON.parse(line);
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let start = 0;
      let end: number;
      while ((end = buffer.indexOf("\n", start)) !== -1) {
        if (end - start > maxLineChars) throw new Error("Runner event exceeds the size limit");
        const line = buffer.slice(start, end).trim();
        start = end + 1;
        if (line) yield parse(line);
      }
      buffer = buffer.slice(start);
      if (buffer.length > maxLineChars) throw new Error("Runner event exceeds the size limit");
      if (done) {
        complete = true;
        if (buffer.trim()) yield parse(buffer.trim());
        return;
      }
    }
  } finally {
    if (!complete) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
