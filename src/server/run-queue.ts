/**
 * Admission control for collection runs: at most `maxActive` runs execute at once
 * and at most `maxQueued` wait, in FIFO order. Shared by manual, REST, MCP and
 * scheduled runs.
 *
 * This is a single-process queue: it coordinates runs inside one Postbox server
 * process only. Running several server processes against one database would need
 * cross-process coordination, which is not implemented.
 */
import { HttpError } from "./errors";

export interface RunQueueLimits {
  maxActive: number;
  maxQueued: number;
}

/** A reserved place in the queue. Exactly one of `release` or `cancel` frees it. */
export interface RunTicket {
  /** Resolves when the run may start; rejects if the ticket is cancelled first. */
  ready: Promise<void>;
  /** 0 when admitted immediately, otherwise the 1-based position at reservation time. */
  position: number;
  /** Free the slot after the run finished (any outcome). Idempotent. */
  release(): void;
  /** Leave the queue (or free the slot) without running. Idempotent. */
  cancel(): void;
}

export class RunQueueFullError extends HttpError {
  constructor(limits: RunQueueLimits) {
    super(
      429,
      `Run queue is full (${limits.maxActive} running, ${limits.maxQueued} waiting). Try again when a run finishes.`,
    );
  }
}

interface Waiter {
  admit: () => void;
  reject: (err: Error) => void;
}

export class RunQueue {
  private active = 0;
  private waiting: Waiter[] = [];

  constructor(private limits: () => RunQueueLimits) {}

  stats() {
    return { active: this.active, queued: this.waiting.length, ...this.limits() };
  }

  /**
   * Reserve a slot synchronously so callers can fail fast (HTTP 429) before doing
   * any expensive work. Throws RunQueueFullError when both run and wait slots are taken.
   */
  reserve(): RunTicket {
    const limits = this.limits();
    let state: "waiting" | "active" | "done" = "waiting";
    const finish = () => {
      if (state === "active") {
        this.active--;
        this.drain();
      }
      state = "done";
    };

    if (this.active < limits.maxActive && this.waiting.length === 0) {
      this.active++;
      state = "active";
      return { ready: Promise.resolve(), position: 0, release: finish, cancel: finish };
    }
    if (this.waiting.length >= limits.maxQueued) throw new RunQueueFullError(limits);

    let waiter!: Waiter;
    const ready = new Promise<void>((resolve, reject) => {
      waiter = {
        admit: () => {
          state = "active";
          resolve();
        },
        reject,
      };
    });
    // Callers that never await `ready` must not cause unhandled rejections.
    ready.catch(() => undefined);
    this.waiting.push(waiter);
    const position = this.waiting.length;
    const cancel = () => {
      if (state === "waiting") {
        this.waiting.splice(this.waiting.indexOf(waiter), 1);
        state = "done";
        waiter.reject(new Error("Run cancelled while queued"));
      } else finish();
    };
    return { ready, position, release: cancel, cancel };
  }

  private drain() {
    const { maxActive } = this.limits();
    while (this.active < maxActive && this.waiting.length) {
      this.active++;
      this.waiting.shift()!.admit();
    }
  }
}
