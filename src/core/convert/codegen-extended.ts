/** Server/core adapter for the maintained client generators; no application dependencies. */
import { randomUUID } from "node:crypto";
import generators from "postman-code-generators";
import sdk from "postman-collection";
import type { AuthConfig } from "../types";
import { byteExpression, replaceByteBody } from "./codegen-bytes";
import { encodeBody } from "../http/body";
import {
  generateSnippet,
  generateCurl,
  generateFetch,
  generatePython,
  generatePowerShell,
  rawBody,
  visibleHeaders,
  type CodegenRequest,
} from "./codegen";
import {
  CODEGEN_LANGUAGES,
  type CodegenLanguage,
  type CodegenOptions,
  type CodegenOption,
} from "./codegen-targets";

export class CodegenInputError extends Error {}

export function validateCodegenOptions(language: CodegenLanguage, input: CodegenOptions): CodegenOptions {
  const target = CODEGEN_LANGUAGES.find((t) => t.id === language);
  if (!target) throw new CodegenInputError(`Unknown snippet target: ${language}`);
  const options: CodegenOptions = {};
  for (const [id, value] of Object.entries(input)) {
    const definition = (target.options as readonly CodegenOption[]).find((o) => o.id === id);
    if (!definition) throw new CodegenInputError(`Option ${id} is not supported by ${target.label}`);
    const valid =
      definition.type === "boolean"
        ? typeof value === "boolean"
        : definition.type === "enum"
          ? typeof value === "string" && definition.availableOptions!.includes(value)
          : typeof value === "number" &&
            Number.isInteger(value) &&
            value >= 0 &&
            value <= (id === "indentCount" ? 8 : 3_600_000);
    if (!valid || (id === "indentCount" && value === 0))
      throw new CodegenInputError(`Invalid value for option ${id}`);
    options[id] = value;
  }
  return options;
}

// Upstream templates disagree about escaping and several parse/rewrite body text.
// Give them opaque values, then escape those values in the final language literal.
// Replacements happen in one pass so user text can never become another token.
function protectRequest(r: CodegenRequest) {
  const prefix = `pbx${randomUUID().replaceAll("-", "")}`;
  const values = new Map<string, string>();
  const token = (value: string) => {
    const key = `${prefix}x${values.size}x`;
    values.set(key, value);
    return key;
  };
  const url = r.url.replace(
    /^(https?:\/\/)?(.*)$/i,
    (_, scheme = "", rest: string) =>
      scheme +
      rest.replace(/[^:/?&=#@]+/g, (part: string) =>
        /[\\\'"$\x00-\x1f\u2028\u2029]/.test(part) ? token(part) : part,
      ),
  );
  const header = visibleHeaders(r).map(([key, value]) => ({
    key: key.toLowerCase() === "content-type" ? key : token(key),
    value: token(value),
  }));
  const raw = rawBody(r.body);
  const body = raw === null ? undefined : { mode: "raw", raw: token(raw) };
  return {
    request: new sdk.Request({ method: r.method, url, header, body }),
    values,
    pattern: new RegExp(`${prefix}x\\d+x`, "g"),
  };
}

function escaped(value: string, language: string, quote: string): string {
  if (language === "php" && quote === "'") return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
  if (language === "shell" || language === "postman-cli") return value.replaceAll("'", "'\\''");
  return Array.from(value, (char) => {
    const point = char.codePointAt(0)!;
    if (char === "\\") return "\\\\";
    if (char === quote) return `\\${char}`;
    if ((language === "dart" || language === "kotlin") && char === "$") return "\\$";
    if (language === "ruby" && char === "#") return "\\#";
    if (language === "ocaml" && point < 32) return `\\${point.toString(10).padStart(3, "0")}`;
    if ((language === "c" || language === "objective-c") && point < 32)
      return `\\${point.toString(8).padStart(3, "0")}`;
    if (char === "\n") return "\\n";
    if (char === "\r") return "\\r";
    if (char === "\t") return "\\t";
    if (language === "ocaml" && (point === 0x2028 || point === 0x2029))
      return Array.from(Buffer.from(char), (byte) => `\\${byte.toString(10).padStart(3, "0")}`).join("");
    if (point < 32 || point === 0x2028 || point === 0x2029) {
      const hex = point.toString(16).padStart(4, "0");
      return language === "swift" || language === "rust" ? `\\u{${hex}}` : `\\u${hex}`;
    }
    return char;
  }).join("");
}

function restoreLiterals(
  code: string,
  language: string,
  values: Map<string, string>,
  pattern: RegExp,
): string {
  if (language === "http") return code.replace(pattern, (token) => values.get(token)!);
  const literals =
    /@"(?:[^"]|"")*"|'''[\s\S]*?'''|"""[\s\S]*?"""|`[^`]*`|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/g;
  let result = code.replace(literals, (literal) => {
    pattern.lastIndex = 0;
    if (!pattern.test(literal)) return literal;
    if (language === "csharp" && literal.startsWith('@"')) {
      return literal.replace(pattern, (token) => values.get(token)!.replaceAll('"', '""'));
    }
    if (language === "go" && literal.startsWith("`")) {
      return JSON.stringify(literal.slice(1, -1).replace(pattern, (token) => values.get(token)!));
    }
    const quote = literal[0];
    return literal.replace(pattern, (token) => escaped(values.get(token)!, language, quote));
  });
  // HTTPie emits header names outside literals. Escape those as shell arguments.
  result = result.replace(pattern, (token) => {
    const value = values.get(token)!;
    if (language === "shell" || language === "postman-cli") return `'${value.replaceAll("'", "'\\''")}'`;
    throw new CodegenInputError(`The ${language} generator cannot safely represent this request field`);
  });
  return result;
}

export async function generateCodeSnippet(
  language: CodegenLanguage,
  request: CodegenRequest,
  input: CodegenOptions = {},
) {
  const options = validateCodegenOptions(language, input);
  const target = CODEGEN_LANGUAGES.find((t) => t.id === language)!;
  const warnings: string[] = [];
  if (
    request.socketPath &&
    language !== "nodejs-native" &&
    (language !== "curl" || request.socketPath.startsWith("\\\\"))
  )
    warnings.push(
      "This request uses a local socket or named pipe. Configure the chosen client's transport before running this snippet.",
    );
  let r: CodegenRequest =
    request.body.mode === "binary" && !request.body.binary ? { ...request, body: { mode: "none" } } : request;
  if (options.trimRequestBody) {
    const b = r.body;
    if (b.mode === "raw") r = { ...r, body: { ...b, raw: b.raw.trim() } };
    else if (b.mode === "formdata")
      r = { ...r, body: { ...b, formdata: b.formdata.map((f) => ({ ...f, value: f.value.trim() })) } };
    else if (b.mode === "urlencoded")
      r = { ...r, body: { ...b, urlencoded: b.urlencoded.map((f) => ({ ...f, value: f.value.trim() })) } };
  }
  let bytes: Buffer | undefined;
  if (
    r.body.mode === "binary" ||
    r.body.mode === "formdata" ||
    (r.body.mode === "raw" && r.body.raw.includes("\0"))
  ) {
    const encoded =
      r.bodyBytes && !options.trimRequestBody
        ? {
            body: Buffer.from(r.bodyBytes),
            contentType: r.headers.find(([key]) => key.toLowerCase() === "content-type")?.[1],
          }
        : encodeBody(r.body, r.method);
    bytes = encoded.body;
    if (r.body.mode === "binary")
      encoded.contentType =
        r.headers.find(([key]) => key.toLowerCase() === "content-type")?.[1] ?? encoded.contentType;
    r = {
      ...r,
      headers: [
        ...r.headers.filter(([k]) => k.toLowerCase() !== "content-type"),
        ["Content-Type", encoded.contentType!],
      ],
      body: { mode: "raw", language: "text", raw: "postboxByteBody" },
    };
    if (
      request.body.mode === "binary" ||
      (request.body.mode === "formdata" && request.body.formdata.some((f) => f.enabled && f.type === "file"))
    )
      warnings.push("Uploaded file bytes are embedded in this snippet.");
  } else if (r.body.mode === "urlencoded") {
    const encoded = encodeBody(r.body, r.method);
    const contentType =
      r.headers.find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? encoded.contentType!;
    r = {
      ...r,
      headers: [
        ...r.headers.filter(([k]) => k.toLowerCase() !== "content-type"),
        ["Content-Type", contentType],
      ],
      body: { mode: "raw", language: "text", raw: encoded.body?.toString("utf8") ?? "" },
    };
  }
  const duplicateHeaders = r.headers.filter(
    ([key], index, headers) =>
      headers.findIndex(([other]) => other.toLowerCase() === key.toLowerCase()) !== index,
  );
  if (duplicateHeaders.length)
    warnings.push(
      "Some client header maps combine or replace repeated header names. Check duplicate headers before running.",
    );
  if (["curl", "fetch", "python", "powershell"].includes(language)) {
    if (language === "curl") {
      const indent = (options.indentType === "Tab" ? "\t" : " ").repeat(Number(options.indentCount ?? 2));
      const code = bytes
        ? `printf '%s' '${bytes.toString("base64")}' | base64 -d | ${generateCurl({ ...r, body: { mode: "none" } }, indent)} \\\n${indent}--data-binary @-`
        : generateCurl(r, indent);
      return { code, warnings };
    }
    let code = generateSnippet(language, r);
    if (bytes) {
      if (language === "fetch")
        code = generateFetch(r).replace('"postboxByteBody"', byteExpression("javascript", bytes));
      else if (language === "python")
        code = generatePython(r).replace('"postboxByteBody"', byteExpression("python", bytes));
      else {
        code = generatePowerShell({ ...r, body: { mode: "none" } })
          .replace(
            "$response =",
            `$body = [System.Convert]::FromBase64String('${bytes.toString("base64")}')\n$response =`,
          )
          .replace(/^(\$response = Invoke-RestMethod .*)$/m, "$1 -Body $body");
      }
    }
    if (language === "python" && !bytes)
      code = code.replace("data=payload)", 'data=payload.encode("utf-8"))');
    if (Object.keys(options).length) {
      const count = Number(options.indentCount ?? (language === "python" ? 4 : 2));
      const unit = (options.indentType === "Tab" ? "\t" : " ").repeat(count);
      const base = language === "python" || language === "powershell" ? 4 : 2;
      code = code.replace(
        /^ +/gm,
        (spaces) => unit.repeat(Math.floor(spaces.length / base)) + " ".repeat(spaces.length % base),
      );
    }
    return { code, warnings };
  }
  if (!/^[A-Z][A-Z0-9_-]*$/.test(r.method))
    throw new CodegenInputError(
      "This target requires an HTTP method containing letters, digits, underscores or hyphens",
    );
  if (target.language === "rust")
    r = { ...r, headers: r.headers.map(([key, value]) => [key.toLowerCase(), value]) };
  const protectedRequest = protectRequest(r);
  const byteToken = bytes
    ? [...protectedRequest.values].find(([, value]) => value === "postboxByteBody")?.[0]
    : undefined;
  // Upstream HTTPie uses request data as printf's format string; keep it data.
  const generated = await new Promise<string>((resolve, reject) =>
    generators.convert(target.language, target.variant, protectedRequest.request, options, (err, snippet) =>
      err ? reject(new CodegenInputError(String(err))) : resolve(snippet),
    ),
  );
  let template = generated;
  if (language === "nodejs-native" && r.socketPath)
    template = template.replace(
      "var options = {",
      `var options = {\n  socketPath: ${JSON.stringify(r.socketPath)},`,
    );
  if (bytes && byteToken) {
    if (["shell", "postman-cli"].includes(target.language)) {
      template = template.replace(new RegExp(`'${byteToken}'`, "g"), "@-");
      // HTTPie consumes stdin. The other tools need a regular temporary file.
      if (target.id === "shell-httpie") template = template.replace(/^printf .*?\| /, "");
      if (target.id === "shell-httpie")
        template = `printf '%s' '${bytes.toString("base64")}' | base64 -d | ${template}`;
      else {
        template = template
          .replace("--body-data @-", '--body-file "$postbox_body_file"')
          .replace("--body @-", '--body "@$postbox_body_file"');
        template = `(\npostbox_body_file=$(mktemp) || exit 1\ntrap 'rm -f "$postbox_body_file"' EXIT HUP INT TERM\nprintf '%s' '${bytes.toString("base64")}' | base64 -d > "$postbox_body_file"\n${template}\n)`;
      }
    } else if (target.language === "http") {
      template = template.replace(byteToken, `[base64 body: ${bytes.toString("base64")}]`);
      warnings.push("Raw HTTP is a text preview. Decode the base64 body to send these binary bytes.");
    } else template = replaceByteBody(template, byteToken, target.language, bytes);
  }
  let code = restoreLiterals(
    template
      .replace(/^printf (?!'%s')/, "printf '%s' ")
      .replace("--no-check-certificate ", "")
      .replace("CURLcode res;", "CURLcode res = CURLE_FAILED_INIT;"),
    target.language,
    protectedRequest.values,
    protectedRequest.pattern,
  );
  if (target.language === "python" && !bytes)
    code = code.replace(/(conn.request\([^\n]+, )payload(, headers\))/, '$1payload.encode("utf-8")$2');
  if (target.language === "http") {
    const raw = rawBody(r.body);
    code = code.replace(
      /^Content-Length: \d+$/m,
      `Content-Length: ${bytes?.length ?? Buffer.byteLength(raw ?? "")}`,
    );
  }
  return { code, warnings };
}

/** Offline snippets carry prepared credentials; they cannot repeat login handshakes. */
export function codegenAuthWarnings(auth: AuthConfig): string[] {
  if (auth.type === "digest" || auth.type === "ntlm")
    return [
      `${auth.type.toUpperCase()} authentication requires configuring the chosen client's challenge/response credentials.`,
    ];
  if (auth.type === "oauth2" && !auth.oauth2.accessToken)
    return [
      "OAuth 2 token acquisition is not executed while generating code. Supply a token or configure the client's token flow.",
    ];
  if (["oauth1", "asap", "awsv4", "hawk", "edgegrid"].includes(auth.type))
    return [
      "The generated signature/token is a snapshot. Regenerate it for later requests or after changing request bytes.",
    ];
  return [];
}
