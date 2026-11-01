import { describe, expect, it } from "vitest";
import { encodeBody, encodeMultipart } from "@/core/http/body";

describe("encodeBody", () => {
  it("mode none returns {}", () => {
    const r = encodeBody({ mode: "none" }, "GET");
    expect(r).toEqual({});
  });

  it("raw json -> application/json and utf8 bytes", () => {
    const r = encodeBody({ mode: "raw", raw: '{"a":1}', language: "json" }, "POST");
    expect(r.contentType).toBe("application/json");
    expect(r.body?.toString("utf8")).toBe('{"a":1}');
  });

  it("raw with empty string on GET returns {}", () => {
    const r = encodeBody({ mode: "raw", raw: "", language: "text" }, "GET");
    expect(r).toEqual({});
  });

  it("raw with empty string on HEAD returns {}", () => {
    const r = encodeBody({ mode: "raw", raw: "", language: "text" }, "HEAD");
    expect(r).toEqual({});
  });

  it("raw xml -> application/xml", () => {
    const r = encodeBody({ mode: "raw", raw: "<a/>", language: "xml" }, "POST");
    expect(r.contentType).toBe("application/xml");
  });

  it("urlencoded skips disabled and empty-key rows", () => {
    const r = encodeBody(
      {
        mode: "urlencoded",
        urlencoded: [
          { key: "a", value: "1", enabled: true },
          { key: "", value: "skip", enabled: true },
          { key: "b", value: "2", enabled: false },
        ],
      },
      "POST",
    );
    expect(r.contentType).toBe("application/x-www-form-urlencoded");
    expect(r.body?.toString("utf8")).toBe("a=1");
  });

  it("binary null returns {}", () => {
    const r = encodeBody({ mode: "binary", binary: null }, "POST");
    expect(r).toEqual({});
  });

  it("binary with missing throws re-select message", () => {
    const fn = () =>
      encodeBody({ mode: "binary", binary: { fileName: "f.bin", data: "", missing: true } }, "POST");
    expect(fn).toThrow("Re-select the binary file before sending this request");
  });

  it("binary decodes base64 with default application/octet-stream", () => {
    const r = encodeBody(
      { mode: "binary", binary: { fileName: "f.bin", data: Buffer.from("hello").toString("base64") } },
      "POST",
    );
    expect(r.contentType).toBe("application/octet-stream");
    expect(r.body?.toString("utf8")).toBe("hello");
  });

  it("binary uses its own contentType when set", () => {
    const r = encodeBody(
      {
        mode: "binary",
        binary: { fileName: "f.bin", data: Buffer.from("x").toString("base64"), contentType: "image/png" },
      },
      "POST",
    );
    expect(r.contentType).toBe("image/png");
  });

  it("graphql builds {query,variables,operationName} JSON", () => {
    const r = encodeBody(
      {
        mode: "graphql",
        graphql: { query: "{q}", variables: '{"x":1}', operationName: "Op" },
      },
      "POST",
    );
    expect(r.contentType).toBe("application/json");
    const parsed = JSON.parse(r.body!.toString("utf8"));
    expect(parsed.query).toBe("{q}");
    expect(parsed.variables).toEqual({ x: 1 });
    expect(parsed.operationName).toBe("Op");
  });

  it("graphql throws on bad variables", () => {
    const fn = () =>
      encodeBody({ mode: "graphql", graphql: { query: "{q}", variables: "not json" } }, "POST");
    expect(fn).toThrow("GraphQL variables are not valid JSON");
  });
});

describe("encodeMultipart", () => {
  it("contains each enabled field, boundary from contentType, and filename for file fields", () => {
    const r = encodeMultipart([
      { key: "name", value: "Alice", type: "text", enabled: true },
      {
        key: "file",
        fileName: "a.txt",
        contentType: "text/plain",
        data: Buffer.from("hi").toString("base64"),
        type: "file",
        enabled: true,
        value: "",
      },
      { key: "off", value: "x", type: "text", enabled: false },
    ]);
    const body = r.body!.toString("utf8");
    expect(r.contentType).toMatch(/^multipart\/form-data; boundary=(.+)$/);
    const boundary = r.contentType!.split("boundary=")[1];
    expect(body).toContain(`--${boundary}\r\nContent-Disposition: form-data; name="name"`);
    expect(body).toContain("Alice");
    expect(body).toContain('filename="a.txt"');
    expect(body).not.toContain('name="off"');
  });

  it("file part body contains the decoded file bytes", () => {
    const r = encodeMultipart([
      {
        key: "file",
        value: "",
        fileName: "a.txt",
        contentType: "text/plain",
        data: Buffer.from("hi").toString("base64"),
        type: "file",
        enabled: true,
      },
    ]);
    const body = r.body!.toString("utf8");
    expect(body).toContain("hi");
  });

  it("throws re-select message for missing file field", () => {
    const fn = () =>
      encodeMultipart([
        { key: "upload", value: "", fileName: "u.bin", type: "file", enabled: true, missing: true },
      ]);
    expect(fn).toThrow('Re-select the file for form-data field "upload" before sending');
  });
});
