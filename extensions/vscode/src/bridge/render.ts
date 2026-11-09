import type { ViewResult } from "./types";

function pretty(body: string, headers: [string, string][]) {
  const type = headers.find(([name]) => name.toLowerCase() === "content-type")?.[1] ?? "";
  if (/json/i.test(type) || /^\s*[[{]/.test(body)) {
    try {
      return { language: "json", text: JSON.stringify(JSON.parse(body), null, 2) };
    } catch {
      /* not JSON after all */
    }
  }
  return { language: /xml|html/i.test(type) ? "xml" : "", text: body };
}

/** Markdown for the result document: status line, tests, response, console. */
export function renderResult(result: ViewResult): string {
  const lines: string[] = [`# ${result.method} ${result.name || result.url}`, ""];
  if (result.error) {
    lines.push(`**Failed:** ${result.error}`, "");
  } else {
    const timing = [
      result.timeMs === null ? null : `${Math.round(result.timeMs)} ms`,
      result.size === null ? null : `${result.size} B`,
    ]
      .filter(Boolean)
      .join(" · ");
    lines.push(
      `**${result.status} ${result.statusText}**${timing ? ` · ${timing}` : ""}`,
      "",
      `\`${result.url}\``,
      "",
    );
  }
  if (result.warnings.length) lines.push(...result.warnings.map((warning) => `> ${warning}`), "");
  if (result.tests.length) {
    const passed = result.tests.filter((test) => test.passed && !test.skipped).length;
    lines.push(`## Tests (${passed}/${result.tests.filter((test) => !test.skipped).length} passed)`, "");
    for (const test of result.tests)
      lines.push(
        `- ${test.skipped ? "○" : test.passed ? "✓" : "✗"} ${test.name}${test.error ? ` — ${test.error}` : ""}`,
      );
    lines.push("");
  }
  if (!result.error) {
    const { language, text } = pretty(result.body, result.headers);
    lines.push(
      "## Response",
      "",
      "```" + language,
      text.length > 200_000 ? text.slice(0, 200_000) + "\n… truncated" : text,
      "```",
      "",
    );
    if (result.headers.length) {
      lines.push(
        "<details><summary>Headers</summary>",
        "",
        ...result.headers.map(([name, value]) => `- **${name}:** ${value}`),
        "",
        "</details>",
        "",
      );
    }
  }
  if (result.logs.length)
    lines.push("## Console", "", ...result.logs.map((entry) => `- ${entry.level}: ${entry.message}`), "");
  return lines.join("\n");
}

export const summaryOf = (result: ViewResult) => {
  if (result.error) return `Failed: ${result.error}`;
  const tests = result.tests.filter((test) => !test.skipped);
  const failed = tests.filter((test) => !test.passed).length;
  return `${result.status} ${result.statusText}${result.timeMs === null ? "" : ` · ${Math.round(result.timeMs)} ms`}${tests.length ? ` · ${failed ? `${failed} of ${tests.length} tests failed` : `${tests.length} tests passed`}` : ""}`;
};
