import { describe, expect, it, vi } from "vitest";
import { readNdjson } from "@/lib/ndjson";

async function collect(stream: ReadableStream<Uint8Array>, limit?: number) {
  const events: unknown[] = [];
  for await (const event of readNdjson(stream, limit)) events.push(event);
  return events;
}

function streamOf(chunks: Uint8Array[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

describe("runner NDJSON reader", () => {
  it("handles split UTF-8, CRLF, blank lines, and a final event without a newline", async () => {
    const bytes = new TextEncoder().encode('\r\n{"name":"café 📬"}\r\n{"type":"done"}');
    const stream = streamOf(Array.from(bytes, (byte) => Uint8Array.of(byte)));
    expect(await collect(stream)).toEqual([{ name: "café 📬" }, { type: "done" }]);
    expect(stream.locked).toBe(false);
  });

  it("cancels and unlocks the stream on invalid JSON", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("invalid\n"));
      },
      cancel,
    });
    await expect(collect(stream)).rejects.toThrow();
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });

  it("bounds incomplete and complete events", async () => {
    for (const text of ['{"long":"value"}', '{"long":"value"}\n']) {
      await expect(collect(streamOf([new TextEncoder().encode(text)]), 8)).rejects.toThrow(/size limit/);
    }
  });

  it("releases the reader when its consumer stops early", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"first":1}\n'));
      },
      cancel,
    });
    for await (const event of readNdjson(stream)) {
      expect(event).toEqual({ first: 1 });
      break;
    }
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });
});
