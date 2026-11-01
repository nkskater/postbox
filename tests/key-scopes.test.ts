import { describe, expect, it } from "vitest";
import { FixedWindowLimiter } from "@/core/ratelimit";
import { KEY_SCOPES, isKeyScope, scopeAllows, scopeAtLeast } from "@/core/scopes";

describe("key scopes", () => {
  it("widens from read to full", () => {
    expect(
      KEY_SCOPES.map((s) => (["read", "run", "write", "manage"] as const).filter((a) => scopeAllows(s, a))),
    ).toEqual([["read"], ["read", "run"], ["read", "run", "write"], ["read", "run", "write", "manage"]]);
    expect(scopeAtLeast("write", "run")).toBe(true);
    expect(scopeAtLeast("run", "write")).toBe(false);
    expect(isKeyScope("full")).toBe(true);
    expect(isKeyScope("root")).toBe(false);
  });
});

describe("fixed window limiter", () => {
  it("allows up to the limit per window, then resets", () => {
    const l = new FixedWindowLimiter();
    expect([1, 2, 3].map((i) => l.hit("k", 2, 1000, i).allowed)).toEqual([true, true, false]);
    expect(l.hit("k", 2, 1000, 3).remaining).toBe(0);
    expect(l.hit("other", 2, 1000, 3).allowed).toBe(true);
    const next = l.hit("k", 2, 1000, 1001);
    expect(next).toMatchObject({ allowed: true, remaining: 1 });
  });

  it("reports whole seconds until reset and stays bounded", () => {
    const l = new FixedWindowLimiter(5);
    expect(l.hit("k", 1, 60_000, 0).resetSeconds).toBe(60);
    expect(l.hit("k", 1, 60_000, 59_900).resetSeconds).toBe(1);
    for (let i = 0; i < 50; i++) l.hit(`k${i}`, 1, 60_000, i);
    expect(l.size()).toBeLessThanOrEqual(5);
  });
});
