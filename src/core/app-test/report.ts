import type { AppTestReport } from "./evaluate";
const escape = (value: unknown) =>
  String(value)
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "")
    .replace(
      /[<>&"']/g,
      (char) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" })[char]!,
    );
export function renderAppTestReport(report: AppTestReport, format: "json" | "junit" | "html") {
  if (format === "json") return JSON.stringify(report, null, 2) + "\n";
  const items = report.calls.map((call) => ({
    name: `${call.index + 1}: ${call.method} ${call.url}`,
    state: call.state,
    detail: [
      ...call.errors,
      ...call.tests.map(
        (t) =>
          `${t.skipped ? "SKIP" : t.passed ? "PASS" : "FAIL"}: ${t.name}${t.error ? `: ${t.error}` : ""}`,
      ),
    ].join("\n"),
  }));
  for (const op of report.operations.filter((op) => !op.matchedCalls))
    items.push({
      name: `Unexercised: ${op.path} / ${op.name}`,
      state: "unmatched",
      detail: "Operation was not exercised",
    });
  if (!report.passed && !items.some((i) => ["failed", "missing-response", "ambiguous"].includes(i.state)))
    items.push({
      name: "Application test policy",
      state: "failed",
      detail: report.commandExit
        ? `UI-test command exited ${report.commandExit}`
        : "No passing assertions or strict coverage requirements were not met",
    });
  if (format === "junit") {
    const failed = items.filter(
      (i) => i.state === "failed" || i.state === "missing-response" || i.state === "ambiguous",
    ).length;
    const skipped = items.filter(
      (i) => i.state !== "passed" && !["failed", "missing-response", "ambiguous"].includes(i.state),
    ).length;
    return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="Postbox observation-only app-test" tests="${items.length}" failures="${failed}" skipped="${skipped}">${items.map((i) => `<testcase name="${escape(i.name)}">${i.state === "passed" ? `<system-out>${escape(i.detail)}</system-out>` : ["failed", "missing-response", "ambiguous"].includes(i.state) ? `<failure message="${escape(i.state)}">${escape(i.detail)}</failure>` : `<skipped message="${escape(i.state)}"/>`}</testcase>`).join("")}</testsuite>\n`;
  }
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Postbox application test report</title><style>body{font:16px system-ui;max-width:1100px;margin:2rem auto;padding:1rem;background:#111;color:#eee}td,th{padding:.6rem;text-align:left;border-bottom:1px solid #555}pre{white-space:pre-wrap;overflow-wrap:anywhere}table{width:100%}</style><h1>Application test report</h1><p>Observation only · ${report.passed ? "Passed" : "Failed"} · No requests replayed</p><pre>${escape(JSON.stringify(report.summary, null, 2))}</pre><table><thead><tr><th>Observed call / operation</th><th>Result</th><th>Assertions / diagnostics</th></tr></thead><tbody>${items.map((i) => `<tr><td>${escape(i.name)}</td><td>${escape(i.state)}</td><td><pre>${escape(i.detail)}</pre></td></tr>`).join("")}</tbody></table></html>\n`;
}
