import { describe, expect, it } from "vitest";
import { createEventStream } from "@/server/event-stream";
import { readNdjson } from "@/lib/ndjson";

describe("bounded progress stream", () => {
  it("delivers events in order and closes cleanly", async () => {
    const events = createEventStream(128);
    expect(events.send({ type: "start" })).toBe(true);
    expect(events.send({ type: "done" })).toBe(true);
    events.close();
    events.close();
    expect(events.send({ type: "late" })).toBe(false);
    const received: unknown[] = [];
    for await (const event of readNdjson(events.stream)) received.push(event);
    expect(received).toEqual([{ type: "start" }, { type: "done" }]);
  });

  it("disconnects stalled readers instead of growing the queue", async () => {
    const events = createEventStream(40);
    expect(events.send({ message: "first" })).toBe(true);
    expect(events.send({ message: "second" })).toBe(false);
    expect(events.send({ message: "later" })).toBe(false);
    await expect(events.stream.getReader().read()).rejects.toThrow(/too slow/);
    expect(() => events.close()).not.toThrow();
  });

  it("still delivers terminal events when the queue is full", async () => {
    const events = createEventStream(40);
    expect(events.send({ message: "fills the queue" })).toBe(true);
    expect(events.send({ type: "done", summary: { status: "passed", totalRequests: 3 } })).toBe(true);
    events.close();
    const received: unknown[] = [];
    for await (const event of readNdjson(events.stream)) received.push(event);
    expect(received.at(-1)).toMatchObject({ type: "done" });
  });

  it("measures queue size in encoded bytes rather than character count", async () => {
    const events = createEventStream(20);
    expect(events.send({ x: "📬📬📬" })).toBe(false);
    await expect(events.stream.getReader().read()).rejects.toThrow(/too slow/);
  });

  it("reclaims queue capacity when events are consumed", async () => {
    const events = createEventStream(24);
    const reader = events.stream.getReader();
    for (let i = 0; i < 100; i++) {
      expect(events.send({ sequence: i })).toBe(true);
      const { value } = await reader.read();
      expect(JSON.parse(new TextDecoder().decode(value))).toEqual({ sequence: i });
    }
    events.close();
    expect((await reader.read()).done).toBe(true);
    reader.releaseLock();
  });

  it("ignores further progress after cancellation", async () => {
    const events = createEventStream();
    await events.stream.cancel();
    expect(events.send({ type: "result" })).toBe(false);
    expect(() => events.close()).not.toThrow();
  });
});
