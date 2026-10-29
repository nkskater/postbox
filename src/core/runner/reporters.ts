/**
 * Run reporters: JSON, JUnit XML and a standalone HTML report.
 */
import type { RunResult, RunSummary } from "./runner";

export function toJsonReport(summary: RunSummary): string {
  return JSON.stringify(summary, null, 2);
}

const xmlEscape = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

/**
 * JUnit XML: one <testsuite> per request execution, one <testcase> per assertion.
 * Requests with network/script errors and no tests get a synthetic failing case.
 */
export function toJUnitReport(summary: RunSummary): string {
  const suites = summary.results.map((r) => {
    const name = `${r.path ? `${r.path} / ` : ""}${r.name}${summary.iterations > 1 ? ` [iteration ${r.iteration + 1}]` : ""}`;
    const time = ((r.timeMs ?? 0) / 1000).toFixed(3);
    const cases: string[] = r.tests.map((t) => {
      const head = `    <testcase name="${xmlEscape(t.name)}" classname="${xmlEscape(name)}" time="${time}">`;
      if (t.skipped) return `${head}<skipped/></testcase>`;
      if (t.passed) return `${head}</testcase>`;
      return `${head}\n      <failure type="AssertionFailure" message="${xmlEscape(t.error ?? "failed")}"><![CDATA[${t.error ?? ""}]]></failure>\n    </testcase>`;
    });
    const errors = [r.error, ...r.scriptErrors.map((e) => `${e.source}: ${e.message}`)].filter(
      Boolean,
    ) as string[];
    if (errors.length) {
      cases.push(
        `    <testcase name="${xmlEscape(r.error ? "Request" : "Scripts")}" classname="${xmlEscape(name)}" time="${time}">\n      <error message="${xmlEscape(errors[0])}"><![CDATA[${errors.join("\n")}]]></error>\n    </testcase>`,
      );
    }
    const failures = r.tests.filter((t) => !t.passed).length;
    const skipped = r.tests.filter((t) => t.skipped).length;
    return `  <testsuite name="${xmlEscape(name)}" tests="${cases.length}" failures="${failures}" errors="${errors.length ? 1 : 0}" skipped="${skipped}" time="${time}" timestamp="${new Date(summary.startedAt).toISOString()}">\n${cases.join("\n")}\n  </testsuite>`;
  });
  const totalCases = summary.results.reduce(
    (n, r) => n + r.tests.length + (r.error || r.scriptErrors.length ? 1 : 0),
    0,
  );
  const errors = summary.results.filter((r) => r.error || r.scriptErrors.length).length;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="${xmlEscape(summary.name)}" tests="${totalCases}" failures="${summary.failedTests}" errors="${errors}" time="${(summary.durationMs / 1000).toFixed(3)}">\n${suites.join("\n")}\n</testsuites>\n`;
}

const h = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function resultRow(r: RunResult): string {
  const badge = r.skipped ? "skip" : r.passed ? "pass" : "fail";
  const tests = r.tests
    .map(
      (t) =>
        `<li class="${t.skipped ? "skip" : t.passed ? "pass" : "fail"}">${t.passed ? "✔" : "✘"} ${h(t.name)}${t.error ? `<div class="err">${h(t.error)}</div>` : ""}</li>`,
    )
    .join("");
  const errs = [r.error, ...r.scriptErrors.map((e) => `${e.source}: ${e.message}`)]
    .filter(Boolean)
    .map((e) => `<div class="err">${h(String(e))}</div>`)
    .join("");
  return `<tr class="${badge}"><td>${r.iteration + 1}</td><td><span class="badge ${badge}">${badge}</span></td><td><b>${h(r.method)}</b> ${h(r.name)}<div class="muted">${h(r.path)}</div><div class="url">${h(r.url)}</div>${errs}${tests ? `<ul>${tests}</ul>` : ""}</td><td>${r.status ?? "—"}</td><td>${r.timeMs ?? "—"} ms</td><td>${r.size ?? "—"} B</td></tr>`;
}

export function toHtmlReport(summary: RunSummary): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${h(summary.name)} – Postbox run report</title>
<style>
:root{--bg:#fff;--fg:#1f2328;--muted:#656d76;--border:#d0d7de;--pass:#1a7f37;--fail:#cf222e;--card:#f6f8fa}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#8d96a0;--border:#30363d;--pass:#3fb950;--fail:#f85149;--card:#161b22}}
body{font:14px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--fg);margin:0;padding:24px}
h1{font-size:20px;margin:0 0 4px}.muted{color:var(--muted);font-size:12px}
.cards{display:flex;gap:12px;flex-wrap:wrap;margin:16px 0}.card{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:10px 16px;min-width:120px}
.card b{display:block;font-size:20px}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid var(--border);padding:8px;text-align:left;vertical-align:top}
.badge{font-size:11px;font-weight:600;text-transform:uppercase;padding:2px 6px;border-radius:4px}.badge.pass{background:color-mix(in srgb,var(--pass) 15%,transparent);color:var(--pass)}
.badge.fail{background:color-mix(in srgb,var(--fail) 15%,transparent);color:var(--fail)}.badge.skip{color:var(--muted)}
ul{margin:6px 0 0;padding-left:16px}li.pass{color:var(--pass)}li.fail{color:var(--fail)}.err{color:var(--fail);font-size:12px}.url{font-family:monospace;font-size:12px;color:var(--muted);word-break:break-all}
</style></head><body>
<h1>${h(summary.name)}</h1>
<div class="muted">Started ${new Date(summary.startedAt).toLocaleString()} · ${summary.durationMs} ms · status: ${summary.status}</div>
<div class="cards">
<div class="card">Iterations<b>${summary.iterations}</b></div>
<div class="card">Requests<b>${summary.totalRequests}</b></div>
<div class="card">Failed requests<b style="color:var(--fail)">${summary.failedRequests}</b></div>
<div class="card">Tests passed<b style="color:var(--pass)">${summary.passedTests}</b></div>
<div class="card">Tests failed<b style="color:var(--fail)">${summary.failedTests}</b></div>
</div>
<table><thead><tr><th>#</th><th>Result</th><th>Request</th><th>Status</th><th>Time</th><th>Size</th></tr></thead>
<tbody>${summary.results.map(resultRow).join("\n")}</tbody></table>
<p class="muted">Generated by Postbox</p>
</body></html>`;
}

export type ReportFormat = "json" | "junit" | "html";

export function renderReport(
  summary: RunSummary,
  format: ReportFormat,
): { body: string; contentType: string; ext: string } {
  switch (format) {
    case "junit":
      return { body: toJUnitReport(summary), contentType: "application/xml", ext: "xml" };
    case "html":
      return { body: toHtmlReport(summary), contentType: "text/html", ext: "html" };
    default:
      return { body: toJsonReport(summary), contentType: "application/json", ext: "json" };
  }
}
