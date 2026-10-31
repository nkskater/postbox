import { describe, expect, it } from "vitest";
import { importHar, isHar } from "@/core/convert/har";
import type { RequestNode } from "@/core/types";
import { formatOutcomeSummary } from "@/components/dialogs/ImportDialog";

const entry = (url = "https://example.test/echo?a=1&a=2") => ({
  startedDateTime: "2026-10-30T12:00:00Z",
  time: 42,
  pageref: "page-1",
  request: {
    method: "POST",
    url,
    headers: [
      { name: "X-Repeat", value: "one" },
      { name: "X-Repeat", value: "two" },
    ],
    queryString: [] as { name: string; value: string }[],
    cookies: [] as { name: string; value: string }[],
    postData: { mimeType: "application/json", text: '{"hello":"world"}' },
  },
  response: {
    status: 200,
    statusText: "OK",
    headers: [
      { name: "X-Repeat", value: "first" },
      { name: "X-Repeat", value: "second" },
    ],
    content: { mimeType: "application/json", text: '{"ok":true}' },
  },
});
const har = (entries: unknown[]) => ({
  log: { version: "1.2", creator: { name: "Fixture", version: "1" }, entries },
});

describe("HAR import", () => {
  it("preserves entry order, duplicate queries and headers, effective body, metadata and response examples", () => {
    const result = importHar(har([entry(), entry("https://example.test/second")]));
    const rows = result.root.children as RequestNode[];
    expect(rows.map((r) => r.name)).toEqual(["1. POST /echo", "2. POST /second"]);
    expect(rows[0].url).toBe("https://example.test/echo?a=1&a=2");
    expect(rows[0].params.map((p) => [p.key, p.value])).toEqual([
      ["a", "1"],
      ["a", "2"],
    ]);
    expect(rows[0].headers.slice(0, 2).map((h) => h.value)).toEqual(["one", "two"]);
    expect(rows[0].body).toMatchObject({ mode: "raw", language: "json", raw: '{\n  "hello": "world"\n}' });
    expect(rows[0].examples?.[0]).toMatchObject({
      status: 200,
      statusText: "OK",
      createdAt: Date.parse("2026-10-30T12:00:00Z"),
    });
    expect(rows[0].examples?.[0].headers.map((h) => h.value)).toEqual(["first", "second"]);
    expect(rows[0].description).toContain("Duration (ms): 42");
    expect(result.root.description).toContain("Fixture 1");
    expect(result.warnings).toEqual([]);
  });
  it("redacts credentials and their echoed encoded forms throughout the archive without corrupting structural fields", () => {
    const first = entry(
      "https://user:credential-password@example.test/echo?token=credential-token&public=yes",
    );
    first.request.headers.push({ name: "Authorization", value: "Bearer credential-bearer" });
    first.request.cookies = [{ name: "session", value: "cookie-secret" }];
    first.request.postData.text = '{"password":"raw","client_secret":"secret-value","name":"public"}';
    first.response.content.text = JSON.stringify({
      echo: "credential-password credential-token credential-bearer cookie-secret secret-value",
      raw: "raw",
    });
    const second = entry("https://example.test/second");
    second.response.content.text = JSON.stringify({
      echo: encodeURIComponent("credential-password"),
      copied: "credential-bearer",
    });
    const result = importHar(har([first, second]));
    const text = JSON.stringify(result);
    for (const secret of [
      "credential-password",
      "credential-token",
      "credential-bearer",
      "cookie-secret",
      "secret-value",
    ])
      expect(text).not.toContain(secret);
    const row = result.root.children[0] as RequestNode;
    expect(row.body.mode).toBe("raw");
    expect(row.url).toBe("https://example.test/echo?public=yes");
    expect(row.params.find((p) => p.key === "token")).toMatchObject({ enabled: false, value: "[REDACTED]" });
    expect(row.headers.find((h) => h.key === "Authorization")?.enabled).toBe(false);
    expect(row.headers.find((h) => h.key === "Cookie")?.enabled).toBe(false);
    expect(row.settings.useCookieJar).toBe(false);
    expect(result.warnings.join(" ")).toContain("Credentials redacted");
  });
  it("removes header-only cookie values and decoded Basic credentials from echoed response artifacts", () => {
    const item = entry();
    item.request.headers.push(
      {
        name: "Authorization",
        value: "Basic " + Buffer.from("fixture-user:fixture-password").toString("base64"),
      },
      { name: "Cookie", value: "session=cookie-value; other=other-value" },
    );
    item.response.headers.push({ name: "Set-Cookie", value: "access=response-cookie; Path=/; Secure" });
    item.response.content.text = JSON.stringify({
      echo: "fixture-user fixture-password cookie-value other-value response-cookie",
      encoded: Buffer.from("fixture-password").toString("base64"),
    });
    const output = JSON.stringify(importHar(har([item])));
    for (const secret of [
      "fixture-user",
      "fixture-password",
      "cookie-value",
      "other-value",
      "response-cookie",
      Buffer.from("fixture-password").toString("base64"),
    ])
      expect(output).not.toContain(secret);
  });
  it("supports URL-encoded and multipart text parameters while diagnosing missing uploaded files", () => {
    const form = entry();
    Object.assign(form.request.postData, {
      mimeType: "application/x-www-form-urlencoded",
      text: undefined,
      params: [
        { name: "x", value: "one" },
        { name: "x", value: "two" },
      ],
    });
    const multipart = structuredClone(form);
    multipart.request.postData.mimeType = "multipart/form-data; boundary=old";
    multipart.request.headers.push({ name: "Content-Type", value: "multipart/form-data; boundary=old" });
    const upload = structuredClone(multipart);
    Object.assign(upload.request.postData, { params: [{ name: "file", fileName: "missing.txt" }] });
    const result = importHar(har([form, multipart, upload]));
    const rows = result.root.children as RequestNode[];
    expect(rows).toHaveLength(2);
    expect(rows[0].body).toMatchObject({
      mode: "urlencoded",
      urlencoded: [
        { key: "x", value: "one" },
        { key: "x", value: "two" },
      ],
    });
    expect(rows[1].body).toMatchObject({
      mode: "formdata",
      formdata: [
        { type: "text", value: "one" },
        { type: "text", value: "two" },
      ],
    });
    expect(rows[1].headers.find((h) => h.key === "Content-Type")?.enabled).toBe(false);
    expect(result.warnings.join(" ")).toContain("Skipped request");
  });
  it("decodes base64 textual examples and distinguishes missing, binary, invalid and unsupported examples", () => {
    const base = entry();
    Object.assign(base.response.content, {
      encoding: "base64",
      text: Buffer.from('{"ok":true}').toString("base64"),
    });
    const missing = structuredClone(base);
    delete (missing.response.content as { text?: string }).text;
    const invalid = structuredClone(base);
    invalid.response.content.text = "%%%";
    const binary = structuredClone(base);
    binary.response.content.mimeType = "image/png";
    const unsupported = structuredClone(base);
    Object.assign(unsupported.response.content, { encoding: "gzip" });
    const result = importHar(har([base, missing, invalid, binary, unsupported]));
    const rows = result.root.children as RequestNode[];
    expect(JSON.parse(rows[0].examples![0].body)).toEqual({ ok: true });
    for (const row of rows.slice(1))
      expect(row.examples?.[0]).toMatchObject({ name: "Captured response (body unavailable)", body: "" });
    expect(result.warnings).toHaveLength(4);
  });
  it("retains explicitly empty JSON request and response bodies", () => {
    const item = entry();
    item.request.postData.text = "";
    item.response.content.text = "";
    const result = importHar(har([item]));
    const request = result.root.children[0] as RequestNode;
    expect(request.body).toMatchObject({ mode: "raw", raw: "" });
    expect(request.examples?.[0]).toMatchObject({ name: "Captured response", body: "" });
    expect(result.warnings).toEqual([]);
  });
  it("skips malformed and unsupported entries with bounded safe diagnostics and rejects empty recordings", () => {
    const unsupported = entry("ftp://example.test/path");
    const oversized = entry();
    oversized.request.postData.text = "x".repeat(1024 * 1024 + 1);
    const result = importHar(har([null, unsupported, oversized, entry()]));
    expect(result.root.children).toHaveLength(1);
    expect(result.warnings).toHaveLength(3);
    expect(() => importHar(har([]))).toThrow(/no importable/);
    expect(() => importHar({ log: { version: "1.1", entries: [] } })).toThrow(/HAR 1.2/);
    expect(isHar({ log: { entries: [] } })).toBe(true);
    expect(isHar({ info: { name: "other" }, item: [] })).toBe(false);
  });
  it("reports unsupported charsets and bounds credential sanitization work", () => {
    const item = entry();
    item.response.content.mimeType = "text/plain; charset=iso-8859-1";
    expect(importHar(har([item])).warnings.join(" ")).toContain("Response body unavailable");
    item.request.headers.push({ name: "Authorization", value: "Bearer " + "s".repeat(100_001) });
    expect(() => importHar(har([item]))).toThrow(/too much credential data/);
  });
  it("does not duplicate query metadata and shows diagnostics in import summaries", () => {
    const item = entry();
    item.request.queryString = [{ name: "a", value: "different" }];
    const result = importHar(har([item]));
    expect((result.root.children[0] as RequestNode).url).toBe("https://example.test/echo?a=1&a=2");
    expect(result.warnings.join(" ")).toContain("retained the URL query");
    expect(
      formatOutcomeSummary({ kind: "collection", name: "HAR", requests: 1, warnings: result.warnings }),
    ).toContain("import warnings");
  });
});

describe("HAR dialog diagnostics", () => {
  it("keeps all import warnings reviewable after a successful import", async () => {
    const { createImportController } = await import("@/components/dialogs/ImportDialog");
    const warnings = [
      "Entry 1: credential redaction",
      "Entry 2: binary response unavailable",
      "Entry 3: skipped upload",
      "Entry 4: missing body",
    ];
    const controller = createImportController(
      {
        getWorkspaceId: () => "workspace",
        refreshTree: async () => {},
        refreshEnvironments: async () => {},
        refreshVariables: async () => {},
        openDraft: () => {},
        setDialogOpen: () => {},
        toastImpl: { success: () => {}, error: () => {} },
        fetchImpl: async () =>
          new Response(JSON.stringify({ kind: "collection", name: "HAR", requests: 1, warnings }), {
            status: 201,
          }),
      },
      { open: true, text: "HAR input" },
    );
    expect(await controller.importText()).toBe(true);
    expect(controller.getState()).toMatchObject({ open: true, busy: false, text: "", warnings });
    controller.handleOpenChange(false);
    expect(controller.getState().warnings).toEqual([]);
  });
});
