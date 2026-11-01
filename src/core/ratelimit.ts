/**
 * Fixed-window request counter, keyed by name (an API key id). Pure and bounded: the clock is
 * passed in, and expired windows are dropped so the table cannot grow without limit.
 */
export interface RateDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Whole seconds until the window resets (at least 1). */
  resetSeconds: number;
}

export class FixedWindowLimiter {
  private windows = new Map<string, { start: number; count: number }>();
  constructor(private maxKeys = 10_000) {}

  hit(key: string, limit: number, windowMs: number, now: number): RateDecision {
    let w = this.windows.get(key);
    if (!w || now - w.start >= windowMs) {
      w = { start: now, count: 0 };
      this.windows.set(key, w);
      if (this.windows.size > this.maxKeys) this.prune(windowMs, now);
    }
    w.count++;
    const resetSeconds = Math.max(1, Math.ceil((w.start + windowMs - now) / 1000));
    return { allowed: w.count <= limit, limit, remaining: Math.max(0, limit - w.count), resetSeconds };
  }

  forget(key: string) {
    this.windows.delete(key);
  }

  size() {
    return this.windows.size;
  }

  private prune(windowMs: number, now: number) {
    for (const [key, w] of this.windows) if (now - w.start >= windowMs) this.windows.delete(key);
    // Still too many live windows: drop the oldest.
    while (this.windows.size > this.maxKeys) this.windows.delete(this.windows.keys().next().value!);
  }
}
