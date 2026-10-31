/** Expressions representing exact request bytes in each client language. */
export function byteExpression(language: string, bytes: Buffer): string {
  const base64 = bytes.toString("base64");
  switch (language) {
    case "javascript":
      return `Uint8Array.from(atob("${base64}"), (c) => c.charCodeAt(0))`;
    case "nodejs":
      return `Buffer.from("${base64}", "base64")`;
    case "csharp":
      return `Convert.FromBase64String("${base64}")`;
    case "dart":
      return `base64Decode("${base64}")`;
    case "java":
    case "kotlin":
      return `java.util.Base64.getDecoder().decode("${base64}")`;
    case "php":
      return `base64_decode('${base64}')`;
    case "python":
      return `__import__('base64').b64decode('${base64}')`;
    case "ruby":
      return `'${base64}'.unpack1('m0')`;
    case "rust":
      return `vec![${Array.from(bytes, (byte) => `${byte}u8`).join(", ")}]`;
    case "r":
      return `as.raw(c(${Array.from(bytes).join(", ")}))`;
    case "swift":
      return `Data(base64Encoded: "${base64}")!`;
    case "objective-c":
      return `[[NSData alloc] initWithBase64EncodedString:@"${base64}" options:0]`;
    case "c":
      return `"${Array.from(bytes, (b) => `\\${b.toString(8).padStart(3, "0")}`).join("")}"`;
    case "ocaml":
      return `"${Array.from(bytes, (b) => `\\${b.toString(10).padStart(3, "0")}`).join("")}"`;
    case "go":
      return `"${Array.from(bytes, (b) => `\\x${b.toString(16).padStart(2, "0")}`).join("")}"`;
    default:
      throw new Error(`No byte expression for ${language}`);
  }
}

export function replaceByteBody(code: string, token: string, language: string, bytes: Buffer): string {
  const literal = `(?:@"${token}"|'''${token}'''|"""${token}"""|\x60${token}\x60|"${token}"|'${token}')`;
  const expression = byteExpression(language, bytes);
  if (language === "csharp")
    code = code.replace(
      new RegExp(`new StringContent\\(${literal}, null, ([^\\n]+)\\);`),
      `new ByteArrayContent(${expression});\ncontent.Headers.ContentType = System.Net.Http.Headers.MediaTypeHeaderValue.Parse($1);`,
    );
  if (language === "objective-c")
    code = code.replace(
      new RegExp(
        `\\[\\[NSData alloc\\] initWithData:\\[${literal} dataUsingEncoding:NSUTF8StringEncoding\\]\\]`,
      ),
      expression,
    );
  code = code.replace(new RegExp(literal, "g"), () => expression);
  if (language === "c")
    code = code.replace(
      "CURLOPT_POSTFIELDS, data);",
      `CURLOPT_POSTFIELDS, data);\n  curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, ${bytes.length}L);`,
    );
  if (language === "swift") code = code.replace("parameters.data(using: .utf8)", "parameters");
  if (language === "dart")
    code = `import 'dart:convert';\n${code.replace("request.body =", "request.bodyBytes =")}`;
  if (language === "javascript") code = code.replace('"data":', '"processData": false,\n  "data":');
  return code;
}
