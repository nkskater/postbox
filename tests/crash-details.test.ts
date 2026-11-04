import { describe, expect, it } from "vitest";
import { formatCrashDetails } from "@/lib/crash-details";

describe("formatCrashDetails", () => {
  it("includes name, message, digest, context and a trimmed stack", () => {
    const err = Object.assign(new TypeError("x is undefined"), { digest: "abc123" });
    err.stack = ["TypeError: x is undefined", ...Array.from({ length: 40 }, (_, i) => `  at f${i}`)].join(
      "\n",
    );
    const text = formatCrashDetails(err, { url: "http://localhost:47392/", userAgent: "UA/1" });
    expect(text).toContain("Error: TypeError: x is undefined");
    expect(text).toContain("Digest: abc123");
    expect(text).toContain("Page: http://localhost:47392/");
    expect(text).toContain("Browser: UA/1");
    expect(text).toContain("at f0");
    expect(text).not.toContain("at f39");
  });

  it("copes with non-Error values", () => {
    expect(formatCrashDetails("boom")).toBe("Error: Error: boom");
    expect(formatCrashDetails(null)).toBe("Error: Error: unknown error");
    expect(formatCrashDetails({ message: 5 })).toBe("Error: Error: unknown error");
  });
});
