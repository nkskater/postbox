import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEventListeners } from "node:events";
import { flattenTree, runCollection, type RunEvent } from "@/core/runner/runner";
import { toHtmlReport, toJUnitReport } from "@/core/runner/reporters";
import {
  dedupeRows,
  deleteColumn,
  filterRows,
  parseCsv,
  parseDataFile,
  parseJsonData,
  renameColumn,
  trimWhitespace,
} from "@/core/runner/data";
import { emptyScopes } from "@/core/variables/resolver";
import { DEFAULT_RUN_OPTIONS, DEFAULT_SETTINGS, type FolderNode, type RequestNode } from "@/core/types";
import * as XLSX from "xlsx";
import { startTestServer, type TestServer } from "./helpers/server";

let server: TestServer;
beforeAll(async () => (server = await startTestServer()));
afterAll(() => server.close());

const req = (name: string, p: Partial<RequestNode> = {}): RequestNode => ({
  kind: "request",
  id: name,
  name,
  method: "GET",
  url: "{{base}}/echo",
  params: [],
  headers: [],
  body: { mode: "none" },
  auth: { type: "inherit" },
  preRequestScript: "",
  testScript: "",
  settings: { ...DEFAULT_SETTINGS },
  ...p,
});

const folder = (name: string, children: FolderNode["children"], p: Partial<FolderNode> = {}): FolderNode => ({
  kind: "folder",
  id: name,
  name,
  auth: { type: "none" },
  headers: [],
  preRequestScript: "",
  testScript: "",
  children,
  ...p,
});

const scopes = () => ({ ...emptyScopes(), environment: { base: server.url } });

describe("collection runner", () => {
  it("can emit all results without retaining them, while keeping accurate counters", async () => {
    const root = folder("Counters", [
      req("pass", { testScript: 'pm.test("pass", () => {}); pm.test.skip("skip", () => {});' }),
      req("fail", { testScript: 'pm.test("fail", () => pm.expect(1).to.equal(2));' }),
      req("skip", { preRequestScript: "pm.execution.skipRequest();" }),
      req("error", { url: "http://127.0.0.1:1/" }),
    ]);
    const events: RunEvent[] = [];
    const { summary } = await runCollection({
      root,
      scopes: scopes(),
      options: { ...DEFAULT_RUN_OPTIONS, iterations: 3 },
      retainResults: false,
      onEvent: (event) => events.push(event),
    });
    expect(summary).toMatchObject({
      status: "failed",
      totalRequests: 12,
      failedRequests: 6,
      totalTests: 6,
      passedTests: 3,
      failedTests: 3,
      results: [],
    });
    expect(events.filter((event) => event.type === "result")).toHaveLength(12);
    expect(events.at(-1)).toMatchObject({ type: "done", summary: { totalRequests: 12, failedRequests: 6 } });
  });

  it("counts results correctly with retention disabled and stop-on-failure", async () => {
    const { summary } = await runCollection({
      root: folder("Stop", [req("error", { url: "http://127.0.0.1:1/" }), req("unreached")]),
      scopes: scopes(),
      options: { ...DEFAULT_RUN_OPTIONS, iterations: 5, stopOnFailure: true },
      retainResults: false,
    });
    expect(summary).toMatchObject({ status: "failed", totalRequests: 1, failedRequests: 1, results: [] });
  });

  it("removes delay cancellation listeners after successful iterations", async () => {
    const controller = new AbortController();
    await runCollection({
      root: folder("Delays", [req("first"), req("second")]),
      scopes: scopes(),
      options: { ...DEFAULT_RUN_OPTIONS, iterations: 8, delayMs: 1 },
      signal: controller.signal,
    });
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("escapes XML delimiters in assertion and request error text", async () => {
    const { summary } = await runCollection({
      root: folder("XML", [
        req("bad", { testScript: 'pm.test("delimiters", () => { throw new Error("]]> <tag> &"); });' }),
      ]),
      scopes: scopes(),
      options: DEFAULT_RUN_OPTIONS,
    });
    summary.results[0].error = "]]> <network> &";
    const xml = toJUnitReport(summary);
    expect(xml).not.toContain("<![CDATA[");
    expect(xml).toContain("]]&gt; &lt;tag&gt; &amp;");
    expect(xml).toContain("]]&gt; &lt;network&gt; &amp;");
  });

  it("flattens nested folders depth-first with ancestor chains", () => {
    const tree = folder("Col", [req("a"), folder("Sub", [req("b"), folder("Deep", [req("c")])]), req("d")]);
    const items = flattenTree(tree);
    expect(items.map((i) => i.request.name)).toEqual(["a", "b", "c", "d"]);
    expect(items[2].path).toBe("Col / Sub / Deep");
    expect(items[2].ancestors.map((a) => a.name)).toEqual(["Col", "Sub", "Deep"]);
  });

  it("maps each data row to variables for its iteration", async () => {
    const tree = folder("Col", [
      req("lookup", {
        url: "{{base}}/echo?asn={{asn_id}}",
        testScript:
          'pm.test("asn matches row", () => pm.expect(pm.response.json().query.asn).to.equal(pm.iterationData.get("asn_id")));',
      }),
    ]);
    const data = parseCsv("asn_id,name\nA-1,first\nA-2,second\nA-3,third\n");
    const events: RunEvent[] = [];
    const { summary } = await runCollection({
      root: tree,
      scopes: scopes(),
      options: { ...DEFAULT_RUN_OPTIONS, iterations: 0 },
      data,
      onEvent: (e) => events.push(e),
    });
    expect(summary.iterations).toBe(3);
    expect(summary.results.map((r) => r.url)).toEqual(
      ["A-1", "A-2", "A-3"].map((a) => `${server.url}/echo?asn=${a}`),
    );
    expect(summary.passedTests).toBe(3);
    expect(summary.status).toBe("passed");
    expect(events[0].type).toBe("start");
    expect(events.at(-1)?.type).toBe("done");
  });

  it("carries variables between requests and supports setNextRequest", async () => {
    const tree = folder("Col", [
      req("login", { testScript: 'pm.environment.set("token", "abc"); pm.execution.setNextRequest("use");' }),
      req("skipped"),
      req("use", {
        headers: [{ key: "X-Token", value: "{{token}}", enabled: true }],
        testScript:
          'pm.test("token sent", () => pm.expect(pm.response.json().headers["x-token"]).to.equal("abc")); postman.setNextRequest(null);',
      }),
      req("never"),
    ]);
    const { summary, scopes: after } = await runCollection({
      root: tree,
      scopes: scopes(),
      options: DEFAULT_RUN_OPTIONS,
    });
    expect(summary.results.map((r) => r.name)).toEqual(["login", "use"]);
    expect(summary.passedTests).toBe(1);
    expect(after.environment.token).toBe("abc");
  });

  it("stops on failure and runs N iterations", async () => {
    const tree = folder("Col", [
      req("ok", { testScript: 'pm.test("ok", () => {});' }),
      req("bad", {
        url: "{{base}}/status?code=500",
        testScript: 'pm.test("is 200", () => pm.response.to.have.status(200));',
      }),
      req("after"),
    ]);
    const stop = await runCollection({
      root: tree,
      scopes: scopes(),
      options: { ...DEFAULT_RUN_OPTIONS, iterations: 3, stopOnFailure: true },
    });
    expect(stop.summary.results.map((r) => r.name)).toEqual(["ok", "bad"]);
    expect(stop.summary.status).toBe("failed");

    const all = await runCollection({
      root: tree,
      scopes: scopes(),
      options: { ...DEFAULT_RUN_OPTIONS, iterations: 2 },
    });
    expect(all.summary.totalRequests).toBe(6);
    expect(all.summary.failedTests).toBe(2);
    expect(all.summary.failedRequests).toBe(2);
  });

  it("honours delay and cancellation", async () => {
    const tree = folder("Col", [req("a"), req("b"), req("c")]);
    const ctrl = new AbortController();
    const started = Date.now();
    const p = runCollection({
      root: tree,
      scopes: scopes(),
      options: { ...DEFAULT_RUN_OPTIONS, delayMs: 150 },
      signal: ctrl.signal,
      onEvent: (e) => e.type === "result" && e.result.name === "b" && ctrl.abort(),
    });
    const { summary } = await p;
    expect(summary.status).toBe("cancelled");
    expect(summary.results.length).toBe(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
  });

  it("can run a selection of requests", async () => {
    const tree = folder("Col", [req("a"), req("b"), req("c")]);
    const { summary } = await runCollection({
      root: tree,
      scopes: scopes(),
      options: DEFAULT_RUN_OPTIONS,
      selectedRequestIds: ["c", "a"],
    });
    expect(summary.results.map((r) => r.name)).toEqual(["a", "c"]);
  });

  it("renders JUnit and HTML reports", async () => {
    const tree = folder("Col <&>", [
      req("good", { testScript: 'pm.test("passes", () => {});' }),
      req("bad", { testScript: 'pm.test("fails", () => pm.expect(1).to.equal(2));' }),
      req("down", { url: "http://127.0.0.1:1/" }),
    ]);
    const { summary } = await runCollection({ root: tree, scopes: scopes(), options: DEFAULT_RUN_OPTIONS });
    const xml = toJUnitReport(summary);
    expect(xml).toContain('<testsuites name="Col &lt;&amp;&gt;"');
    expect(xml).toContain('<testcase name="passes"');
    expect(xml).toContain('<failure type="AssertionFailure" message="expected 1 to equal 2"');
    expect(xml).toMatch(/<error message="Connection refused/);
    const html = toHtmlReport(summary);
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("Tests failed");
  });
});

describe("iteration data", () => {
  it("parses CSV, JSON and XLSX", () => {
    expect(parseCsv("﻿a, b\n1,2\n\n3,4\n")).toEqual({
      columns: ["a", "b"],
      rows: [
        { a: "1", b: "2" },
        { a: "3", b: "4" },
      ],
    });
    expect(parseJsonData('[{"a":1,"n":{"x":1}},{"b":true}]')).toEqual({
      columns: ["a", "n", "b"],
      rows: [
        { a: "1", n: '{"x":1}', b: "" },
        { a: "", n: "", b: "true" },
      ],
    });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        ["asn_id", "qty"],
        ["A1", 5],
        ["A2", 7],
      ]),
      "Sheet1",
    );
    const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
    expect(parseDataFile("data.xlsx", new Uint8Array(buf))).toEqual({
      columns: ["asn_id", "qty"],
      rows: [
        { asn_id: "A1", qty: "5" },
        { asn_id: "A2", qty: "7" },
      ],
    });
  });

  it("supports grid operations", () => {
    const t = {
      columns: [" a ", "b"],
      rows: [
        { " a ": " x ", b: "1" },
        { " a ": "x", b: "1" },
        { " a ": "y", b: "2" },
      ],
    };
    const trimmed = trimWhitespace(t);
    expect(trimmed.columns).toEqual(["a", "b"]);
    expect(dedupeRows(trimmed).rows).toHaveLength(2);
    expect(deleteColumn(trimmed, "b").columns).toEqual(["a"]);
    expect(renameColumn(trimmed, "a", "asn_id").rows[0]).toEqual({ asn_id: "x", b: "1" });
    expect(filterRows(trimmed, "b=2").rows).toEqual([{ a: "y", b: "2" }]);
    expect(filterRows(trimmed, "b!=2").rows).toHaveLength(2);
    expect(filterRows(trimmed, "Y").rows).toHaveLength(1);
  });
});
