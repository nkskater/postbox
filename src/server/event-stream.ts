/**
 * Bounded, non-blocking progress delivery. A stalled subscriber is disconnected;
 * the background job can continue persisting results without retaining its events.
 */
export function createEventStream(maxQueuedBytes = 1024 * 1024) {
  if (!Number.isSafeInteger(maxQueuedBytes) || maxQueuedBytes <= 0) {
    throw new Error("Event queue size must be a positive integer");
  }
  const encoder = new TextEncoder();
  let closed = false;
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>(
    {
      start(value) {
        controller = value;
      },
      cancel() {
        closed = true;
      },
    },
    { highWaterMark: maxQueuedBytes, size: (chunk) => chunk.byteLength },
  );

  return {
    stream,
    send(event: unknown): boolean {
      if (closed) return false;
      const chunk = encoder.encode(JSON.stringify(event) + "\n");
      if (chunk.byteLength > (controller.desiredSize ?? 0)) {
        closed = true;
        controller.error(
          new Error("Run progress consumer is too slow. Retrieve persisted results from run history."),
        );
        return false;
      }
      controller.enqueue(chunk);
      return true;
    },
    close() {
      if (closed) return;
      closed = true;
      controller.close();
    },
  };
}
