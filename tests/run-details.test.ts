import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { recordExecution } from "@/core/runner/details";
import { RunResultDetails } from "@/components/runner/RunResultDetails";
import { prettyRecordedBody } from "@/lib/run-details";
import type { ExecuteResult } from "@/core/executor";
import type { RunResult } from "@/core/runner/runner";
import { emptyScopes } from "@/core/variables/resolver";

function execution(text = '{"ok":true}'): ExecuteResult {
  return {
    sent: {
      method: "POST",
      url: "https://example.test/?key=secret123",
      headers: [["X-Key", "secret123"]],
      body: "secret123",
      bodySize: 9,
    },
    response: {
      httpVersion: "1.1",
      redirects: [],
      cookies: [],
      status: 200,
      statusText: "OK",
      url: "https://example.test/final",
      headers: [
        ["X-Repeat", "first"],
        ["X-Repeat", "second"],
      ],
      bodyText: text,
      bodyBase64: Buffer.from(text).toString("base64"),
      isBinary: false,
      contentType: "application/json",
      truncated: false,
      size: Buffer.byteLength(text),
      headersSize: 10,
      timings: { dns: 1, tcp: 2, tls: 3, ttfb: 4, download: 5, total: 15 },
    },
    tests: [],
    logs: [],
    scriptErrors: [],
    scopes: emptyScopes(),
    unresolved: [],
    skipped: false,
    nextRequestSet: false,
  };
}
const result: RunResult = {
  iteration: 1,
  sequence: 3,
  requestId: "one",
  name: "One",
  path: "Collection",
  method: "POST",
  url: "https://example.test/",
  status: 200,
  statusText: "OK",
  timeMs: 15,
  size: 11,
  tests: [],
  scriptErrors: [],
  error: null,
  passed: true,
  skipped: false,
};

describe("recorded run details", () => {
  it("retains effective request, ordered repeated headers, response text and timings with secrets redacted", () => {
    const details = recordExecution(execution('{"token":"secret123"}'), ["secret123"]);
    expect(JSON.stringify(details)).not.toContain("secret123");
    expect(details.request).toMatchObject({ method: "POST", body: { state: "complete", text: "********" } });
    expect(details.response?.headers).toEqual([
      ["X-Repeat", "first"],
      ["X-Repeat", "second"],
    ]);
    expect(details.response?.timings.total).toBe(15);
    expect(details.response?.url).toBe("https://example.test/final");
    expect(details.response?.body.text).toBe('{"token":"********"}');
    expect(JSON.stringify(details)).not.toContain("bodyBase64");
  });
  it("retains responses beyond the old excerpt and marks byte and engine truncation honestly", () => {
    const r = execution("x".repeat(20_000));
    expect(recordExecution(r, []).response?.body).toMatchObject({
      state: "complete",
      text: r.response!.bodyText,
    });
    expect(recordExecution(r, [], 128).response?.body).toMatchObject({
      state: "truncated",
      text: "x".repeat(128),
    });
    r.response!.truncated = true;
    expect(recordExecution(r, []).response?.body.state).toBe("truncated");
    r.response!.bodyText = "abcsecret";
    expect(recordExecution(r, ["secret123"]).response?.body.text).toBe("abc");
  });
  it("redacts before retention and does not keep partial UTF-8 characters", () => {
    expect(recordExecution(execution("secret123end"), ["secret123"], 5).response?.body.text).toBe("*****");
    expect(recordExecution(execution("ééé"), [], 3).response?.body.text).toBe("é");
  });
  it("distinguishes empty, skipped, binary and unretained request payloads", () => {
    expect(recordExecution(execution(""), []).response?.body).toMatchObject({ state: "complete", text: "" });
    const r = execution();
    r.sent!.bodySize = 70_000;
    expect(recordExecution(r, []).request?.body.state).toBe("unavailable");
    expect(recordExecution(execution(), [], undefined, true).request?.body.state).toBe("unavailable");
    r.response!.isBinary = true;
    expect(recordExecution(r, []).response?.body).toMatchObject({ state: "unavailable" });
    delete r.sent;
    delete r.response;
    expect(recordExecution(r, [])).toEqual({ request: undefined, response: undefined });
  });
  it("formats JSON and XML while preserving malformed JSON and plain text", () => {
    expect(prettyRecordedBody('{"ok":true}', "application/json")).toBe('{\n  "ok": true\n}');
    expect(prettyRecordedBody("{broken", "application/json")).toBe("{broken");
    expect(prettyRecordedBody("plain", "text/plain")).toBe("plain");
    expect(prettyRecordedBody("<root><child>ok</child></root>", "application/xml")).toContain("\n");
  });
  it("renders legacy, empty, unavailable and partial states as escaped text with execution identity", () => {
    const html = renderToStaticMarkup(
      createElement(RunResultDetails, { result: { ...result, responseBody: "<script>bad()</script>" } }),
    );
    expect(html).toContain("Iteration 2");
    expect(html).toContain("Execution 4");
    expect(html).toContain("Legacy response excerpt");
    expect(html).toContain("Effective request details were not retained");
    expect(html).not.toContain("<script>");
    const complete = renderToStaticMarkup(
      createElement(RunResultDetails, {
        result: { ...result, executionDetails: recordExecution(execution(""), []) },
      }),
    );
    expect(complete).toContain("Empty body");
    expect(complete).toContain("Pretty");
    expect(complete).toContain("Raw");
  });
});
