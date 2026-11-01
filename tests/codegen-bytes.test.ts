import { describe, expect, it } from "vitest";
import { byteExpression, replaceByteBody } from "@/core/convert/codegen-bytes";

const bytes = Buffer.from([0x00, 0x41, 0xff, 0x0a]);
const b64 = bytes.toString("base64");

describe("byteExpression", () => {
  it("nodejs", () => {
    expect(byteExpression("nodejs", bytes)).toBe(`Buffer.from("${b64}", "base64")`);
  });
  it("python", () => {
    expect(byteExpression("python", bytes)).toBe(`__import__('base64').b64decode('${b64}')`);
  });
  it("rust", () => {
    expect(byteExpression("rust", bytes)).toBe("vec![0u8, 65u8, 255u8, 10u8]");
  });
  it("r", () => {
    expect(byteExpression("r", bytes)).toBe("as.raw(c(0, 65, 255, 10))");
  });
  it("go", () => {
    expect(byteExpression("go", bytes)).toBe(String.raw`"\x00\x41\xff\x0a"`);
  });
  it("c", () => {
    expect(byteExpression("c", bytes)).toBe(String.raw`"\000\101\377\012"`);
  });
  it("throws for unknown language", () => {
    expect(() => byteExpression("cobol", bytes)).toThrow("No byte expression for cobol");
  });
});

describe("replaceByteBody", () => {
  it("nodejs replaces the quoted token", () => {
    expect(replaceByteBody('body = "TOKEN";', "TOKEN", "nodejs", bytes)).toBe(
      `body = ${byteExpression("nodejs", bytes)};`,
    );
  });
  it("python replaces the quoted token", () => {
    expect(replaceByteBody("x = 'TOKEN'", "TOKEN", "python", bytes)).toBe(
      `x = ${byteExpression("python", bytes)}`,
    );
  });
  it("c adds POSTFIELDSIZE", () => {
    const result = replaceByteBody(
      'data = "TOKEN";\n  curl_easy_setopt(curl, CURLOPT_POSTFIELDS, data);',
      "TOKEN",
      "c",
      bytes,
    );
    expect(result).toContain("CURLOPT_POSTFIELDSIZE, 4L");
  });
  it("dart adds import and bodyBytes", () => {
    const result = replaceByteBody('request.body = "TOKEN";', "TOKEN", "dart", bytes);
    expect(result.startsWith("import 'dart:convert';")).toBe(true);
    expect(result).toContain("request.bodyBytes =");
  });
  it("swift removes data(using: .utf8)", () => {
    expect(replaceByteBody("let d = parameters.data(using: .utf8)", "TOKEN", "swift", bytes)).toBe(
      "let d = parameters",
    );
  });
});
