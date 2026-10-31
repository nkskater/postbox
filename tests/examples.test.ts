import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { exampleFromResponse, sanitizeExample, validateExamples, requestFromExample } from "@/core/examples";
import { sanitizeRequestDraftForBrowser } from "@/core/retention";
import { importPostmanCollection, exportPostmanCollection } from "@/core/convert/postman";
import { DEFAULT_SETTINGS, type RequestNode, type ResponseExample, type RequestDef } from "@/core/types";
const fixture = JSON.parse(
  fs.readFileSync(new URL("./fixtures/examples/paired.postman.json", import.meta.url), "utf8"),
);
const request: RequestDef = {
  id: "request",
  name: "Parent",
  method: "GET",
  url: "{{baseUrl}}/pets/7",
  params: [],
  headers: [],
  body: { mode: "none" },
  auth: { type: "none" },
  settings: { ...DEFAULT_SETTINGS },
  preRequestScript: "",
  testScript: "",
};
const example = (): ResponseExample => ({
  id: "example",
  name: "OK",
  status: 200,
  statusText: "OK",
  headers: [],
  body: "",
  createdAt: 1,
  originalRequest: request,
});
describe("paired examples and retention", () => {
  it("preserves distinct originalRequest templates and response fields on Postman round trips", () => {
    const imported = importPostmanCollection(fixture),
      first = imported.root.children[0] as RequestNode;
    expect(first.url).toBe("https://api.example/current");
    const snapshot = first.examples![0];
    expect(snapshot.originalRequest).toMatchObject({
      method: "PATCH",
      url: "{{baseUrl}}/pets/7?enabled=yes",
      params: [
        { key: "enabled", value: "yes", enabled: true },
        { key: "disabled", value: "no", enabled: false },
      ],
      headers: [{ key: "X-Snapshot", value: "historical" }],
      body: { mode: "graphql", graphql: { operationName: "Pet" } },
      description: "Original template",
    });
    expect(snapshot.originalRequest?.auth).toEqual({ type: "bearer", bearer: { token: "" } });
    expect(JSON.stringify(snapshot)).not.toContain("snapshot-secret");
    expect(JSON.stringify(snapshot)).not.toContain("variable-secret");
    const exported = exportPostmanCollection(imported.root, imported.variables, {
      includeCredentials: true,
      includeSecrets: true,
    });
    const again = importPostmanCollection(exported).root.children[0] as RequestNode;
    expect(again.examples![0]).toMatchObject({
      ...snapshot,
      id: expect.any(String),
      createdAt: expect.any(Number),
    });
    expect(exported.item[0].response![0].originalRequest).toBeDefined();
  });
  it("captures the supplied request template, binary/text response bytes and truncation state", () => {
    const text = exampleFromResponse(request, {
      status: 201,
      statusText: "Created",
      headers: [["Content-Type", "text/plain"]],
      bodyText: "café 🐾",
      truncated: true,
    });
    expect(text).toMatchObject({ body: "café 🐾", truncated: true, originalRequest: { url: request.url } });
    const data = Buffer.from([0, 255, 1, 2]).toString("base64");
    const binary = exampleFromResponse(request, {
      status: 200,
      statusText: "OK",
      headers: [],
      bodyText: "",
      bodyBase64: data,
      isBinary: true,
    });
    expect(binary.body).toBe(data);
    expect(binary.bodyEncoding).toBe("base64");
    expect(validateExamples([binary])).toHaveLength(1);
    expect(requestFromExample({ ...example(), originalRequest: undefined }, request).url).toBe(request.url);
  });
  it("redacts snapshot credentials, sensitive fields, encoded echoes, userinfo and upload bytes while retaining IDs", () => {
    const raw = example();
    raw.id = "literal-secret-id";
    raw.originalRequest = {
      ...request,
      url: "https://user:literal-secret@api.example/pets?api_key=query-secret",
      auth: { type: "bearer", bearer: { token: "literal-secret" } },
      headers: [{ key: "Authorization", value: "Bearer header-secret", enabled: true }],
      body: {
        mode: "binary",
        binary: { fileName: "payload.bin", data: Buffer.from("upload bytes").toString("base64") },
      },
    };
    raw.body = "literal-secret query-secret Bearer header-secret inherited-secret";
    const safe = sanitizeExample(raw, ["inherited-secret"]);
    expect(safe.id).toBe(raw.id);
    expect(safe.originalRequest?.body).toMatchObject({
      binary: { data: "", missing: true, fileName: "payload.bin" },
    });
    for (const secret of ["query-secret", "header-secret", "inherited-secret", "upload bytes"])
      expect(JSON.stringify(safe)).not.toContain(secret);
    expect(safe.body).not.toContain("literal-secret");
    expect(safe.originalRequest?.url).not.toContain("literal-secret");
    const browser = sanitizeRequestDraftForBrowser({ ...request, examples: [raw] });
    expect(browser.examples[0].originalRequest?.body).toMatchObject({ binary: { data: "", missing: true } });
    expect(browser.examples[0].originalRequest?.auth).toEqual({ type: "bearer", bearer: { token: "" } });
  });
  it("omits binary responses containing recognized secrets and preserves safe binary metadata through export", () => {
    const hidden = exampleFromResponse(
      request,
      {
        status: 200,
        statusText: "OK",
        headers: [],
        bodyText: "",
        bodyBase64: Buffer.from("prefix credential-secret suffix").toString("base64"),
        isBinary: true,
      },
      ["credential-secret"],
    );
    expect(hidden).toMatchObject({ body: "", bodyOmitted: true, bodyEncoding: "base64" });
    expect(validateExamples([hidden])).toHaveLength(1);
    const root = importPostmanCollection(fixture).root;
    (root.children[0] as RequestNode).examples = [{ ...hidden, truncated: true }];
    const exported = exportPostmanCollection(root),
      back = importPostmanCollection(exported).root.children[0] as RequestNode;
    expect(back.examples![0]).toMatchObject({
      body: "",
      bodyOmitted: true,
      bodyEncoding: "base64",
      truncated: true,
    });
  });
  it("retains protocol structure when a short secret collides with a method, body mode or auth enum", () => {
    const raw = {
      ...example(),
      body: "POST raw json header apikey",
      originalRequest: {
        ...request,
        method: "POST",
        body: { mode: "raw" as const, language: "json" as const, raw: "payload" },
        auth: {
          type: "apikey" as const,
          apikey: { key: "X-Key", value: "credential", in: "header" as const },
        },
      },
    };
    const safe = sanitizeExample(raw, ["POST", "raw", "json", "header", "apikey"]);
    expect(safe.body).not.toContain("POST");
    expect(safe.originalRequest).toMatchObject({
      method: "POST",
      body: { mode: "raw", language: "json" },
      auth: { type: "apikey", apikey: { in: "header", value: "" } },
    });
    expect(validateExamples([safe])).toHaveLength(1);
  });
  it("omits current parent credentials and upload bytes when trying a legacy example without a snapshot", () => {
    const legacy = { ...example(), originalRequest: undefined };
    const fallback = {
      ...request,
      auth: { type: "bearer" as const, bearer: { token: "parent-secret" } },
      body: {
        mode: "binary" as const,
        binary: { fileName: "parent.bin", data: Buffer.from("private upload").toString("base64") },
      },
    };
    const tried = requestFromExample(legacy, fallback);
    expect(tried.auth).toEqual({ type: "bearer", bearer: { token: "" } });
    expect(tried.body).toMatchObject({
      mode: "binary",
      binary: { data: "", missing: true, fileName: "parent.bin" },
    });
  });
  it("rejects invalid statuses, response header injection, duplicate IDs and oversized or malformed bodies", () => {
    for (const patch of [
      { status: 0 },
      { status: 600 },
      { statusText: "OK\r\nInjected: yes" },
      { headers: [{ key: "X-Test", value: "line\r\nInjected: yes", enabled: true }] },
      { bodyEncoding: "base64", body: "invalid!" },
    ])
      expect(() => validateExamples([{ ...example(), ...patch } as ResponseExample])).toThrow();
    expect(() => validateExamples([example(), example()])).toThrow(/unique/);
    expect(() => validateExamples([{ ...example(), body: "🐾".repeat(2 * 1024 * 1024) }])).toThrow(/5 MiB/);
    expect(() =>
      validateExamples(Array.from({ length: 101 }, (_, i) => ({ ...example(), id: String(i) }))),
    ).toThrow(/100/);
  });
});
