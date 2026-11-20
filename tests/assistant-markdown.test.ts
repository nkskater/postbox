import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown, safeUrl } from "@/components/assistant/Markdown";

const html = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }));

const REPLY = [
  "## What happened",
  "",
  "The server returned **401** because the `Authorization` header is *missing*.",
  "",
  "```json",
  '{ "error": "unauthorized" }',
  "```",
  "",
  "1. Add the header",
  "   - use `{{token}}`",
  "   - keep it secret",
  "2. Send again",
  "",
  "| Header | Value |",
  "| --- | --- |",
  "| Authorization | Bearer {{token}} |",
  "",
  "> Note: tokens expire.",
  "",
  "---",
  "",
  "See [the docs](https://example.test/docs).",
].join("\n");

describe("assistant Markdown renderer", () => {
  it("renders headings, emphasis, code, nested lists, tables, quotes, rules and links", () => {
    const out = html(REPLY);
    expect(out).toContain("<h3");
    expect(out).toContain("What happened</h3>");
    expect(out).toContain("<strong>401</strong>");
    expect(out).toContain("<em>missing</em>");
    expect(out).toMatch(/<code[^>]*>Authorization<\/code>/);
    expect(out).toContain("<pre");
    expect(out).toContain("&quot;error&quot;: &quot;unauthorized&quot;");
    expect(out).toContain(">json<");
    expect(out).toMatch(/<ol[^>]*>[\s\S]*<ul[^>]*>[\s\S]*keep it secret[\s\S]*<\/ul>[\s\S]*<\/ol>/);
    expect(out).toContain("<table");
    expect(out).toMatch(/<th[^>]*>Header<\/th>/);
    expect(out).toContain("<blockquote");
    expect(out).toContain("<hr");
    expect(out).toContain('href="https://example.test/docs" target="_blank" rel="noopener noreferrer"');
    // No Markdown syntax is left over.
    expect(out).not.toMatch(/##|\*\*|```/);
  });

  it("keeps code blocks and tables inside a horizontal scroll container", () => {
    const out = html("```\n" + "x".repeat(500) + "\n```\n\n| a |\n| - |\n| b |");
    expect(out).toMatch(/<pre class="[^"]*overflow-x-auto/);
    expect(out).toMatch(/<div class="[^"]*overflow-x-auto[^"]*"><table/);
  });

  it("renders raw HTML as inert text", () => {
    const out = html(
      'Hi <script>alert(1)</script> <img src=x onerror="alert(1)">\n\n<div onclick="x()">block</div>',
    );
    expect(out).not.toContain("<script");
    expect(out).not.toMatch(/<img/);
    // The markup survives only as escaped text, never as an element or attribute.
    expect(out).not.toMatch(/<[a-z][^>]*\son(error|click)=/i);
    expect(out).toContain("&lt;img src=x onerror=");
    expect(out).toContain("&lt;script&gt;");
  });

  it("drops unsafe links and never loads images", () => {
    const out = html(
      "[run](javascript:alert(1)) [data](data:text/html,x) [rel](/api/x) [mail](mailto:a@b.test) ![logo](https://evil.test/x.png)",
    );
    expect(out).not.toContain("javascript:");
    expect(out).not.toContain("data:text");
    expect(out).not.toContain('href="/api/x"');
    expect(out).toContain('href="mailto:a@b.test"');
    expect(out).not.toContain("<img");
    expect(out).not.toContain("evil.test");
    expect(out).toContain("[image: logo]");
    expect(safeUrl(" JavaScript:alert(1)")).toBe("");
    expect(safeUrl("https://ok.test")).toBe("https://ok.test");
  });

  it("tolerates incomplete Markdown while a reply streams", () => {
    const partial = html('Here is the body:\n\n```json\n{\n  "name": "Ada"');
    expect(partial).toContain("<pre");
    expect(partial).toContain("&quot;Ada&quot;");
    expect(() => html("**bold but not closed")).not.toThrow();
    expect(html("**bold but not closed")).toContain("bold but not closed");
  });
});
