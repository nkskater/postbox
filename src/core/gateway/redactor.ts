import { credentialRedactionValues } from "../retention";

/** Byte-level streaming redaction holds only a possible secret suffix between chunks. */
export class GatewayRedactor {
  private pending = Buffer.alloc(0);
  private readonly needles: Buffer[];
  private readonly keep: number;
  constructor(secrets: readonly string[]) {
    this.needles = [...new Set(credentialRedactionValues(secrets).filter(Boolean))]
      .map((s) => Buffer.from(s))
      .sort((a, b) => b.length - a.length);
    this.keep = Math.max(0, ...this.needles.map((b) => b.length - 1));
  }
  feed(chunk: Buffer, final = false): Buffer {
    this.pending = Buffer.concat([this.pending, chunk]);
    const limit = final ? this.pending.length : Math.max(0, this.pending.length - this.keep);
    const parts: Buffer[] = [];
    let at = 0,
      start = 0;
    while (at < limit) {
      const needle = this.needles.find((n) => this.pending.subarray(at, at + n.length).equals(n));
      if (needle) {
        parts.push(this.pending.subarray(start, at), Buffer.from("[redacted]"));
        at += needle.length;
        start = at;
      } else at++;
    }
    parts.push(this.pending.subarray(start, at));
    this.pending = Buffer.from(this.pending.subarray(at));
    return Buffer.concat(parts);
  }
}
