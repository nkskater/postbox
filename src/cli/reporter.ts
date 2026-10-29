import type { RunEvent } from "../core/runner/runner";
import { redactSecrets } from "../core/variables/resolver";

export function consoleReporter(secrets: string[]): (event: RunEvent) => void {
  const print = (line: string) => console.log(redactSecrets(line, secrets));
  return (event) => {
    if (event.type === "start") {
      print(`Postbox: ${event.name} (${event.iterations} iteration(s))`);
    } else if (event.type === "result") {
      const r = event.result;
      print(
        `${r.skipped ? "SKIP" : r.passed ? "PASS" : "FAIL"} [${r.iteration + 1}] ${r.method} ${r.name} (${r.status ?? "error"}, ${r.timeMs ?? 0} ms)`,
      );
      if (r.error) print(`  ${r.error}`);
      for (const error of r.scriptErrors) print(`  ${error.source}: ${error.message}`);
      for (const test of r.tests) {
        print(
          `  ${test.skipped ? "SKIP" : test.passed ? "PASS" : "FAIL"} ${test.name}${test.error ? `: ${test.error}` : ""}`,
        );
      }
    } else if (event.type === "log") {
      for (const entry of event.entries) print(`  [${entry.level}] ${entry.message}`);
    } else if (event.type === "done") {
      const s = event.summary;
      print(`\n${s.status.toUpperCase()} — ${s.durationMs} ms`);
      print("                 Total  Passed  Failed");
      print(
        `Requests  ${String(s.totalRequests).padStart(12)}${String(s.totalRequests - s.failedRequests).padStart(8)}${String(s.failedRequests).padStart(8)}`,
      );
      print(
        `Tests     ${String(s.totalTests).padStart(12)}${String(s.passedTests).padStart(8)}${String(s.failedTests).padStart(8)}`,
      );
    }
  };
}
