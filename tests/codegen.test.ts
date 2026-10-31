import { describe, expect, it } from "vitest";
import vm from "node:vm";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import generators from "postman-code-generators";
import { CODEGEN_LANGUAGES, type CodegenLanguage, type CodegenOptions } from "@/core/convert/codegen-targets";
import { generateCodeSnippet } from "@/core/convert/codegen-extended";
import type { CodegenRequest } from "@/core/convert/codegen";

const raw = "before\n'\"\\\r\n café 日本語 🚀 \\u0022 $HOME #{bad} ` %s %nafter";
const request: CodegenRequest = {
  method: "POST",
  url: "https://api.test/path?x=1&x=2&quoted='\"",
  headers: [
    ["Content-Type", "application/json"],
    ["Authorization", "Bearer it'\"s\\$HOME"],
  ],
  body: { mode: "raw", language: "json", raw },
};
const hasCpp = spawnSync("g++", ["--version"]).status === 0;
const javascript = CODEGEN_LANGUAGES.filter((t) => t.editor === "javascript");

// Run generated JavaScript with fake clients, asserting the arguments actually
// received rather than comparing templates to their own implementation.
async function executeJs(target: CodegenLanguage, req: CodegenRequest) {
  const { code } = await generateCodeSnippet(target, req);
  const captured: { url?: string; body?: unknown; headers?: unknown; socketPath?: string } = {};
  const resolved = Promise.resolve({ text: async () => "", data: {} });
  const native = {
    request: (
      options: { hostname: string; path: string; headers: unknown; socketPath?: string },
      _callback: (r: unknown) => void,
    ) => {
      captured.url = `https://${options.hostname}${options.path}`;
      captured.headers = options.headers;
      captured.socketPath = options.socketPath;
      return {
        write: (body: unknown) => {
          captured.body = body;
        },
        end: () => {},
        on: () => {},
      };
    },
  };
  const chain: Record<string, unknown> = {};
  chain.headers = (headers: unknown) => {
    captured.headers = headers;
    return chain;
  };
  chain.send = (body: unknown) => {
    captured.body = body;
    return chain;
  };
  chain.end = () => chain;
  const require = (name: string) => {
    if (name === "axios")
      return {
        request: (config: { url: string; headers: unknown; data: unknown }) => {
          captured.url = config.url;
          captured.headers = config.headers;
          captured.body = config.data;
          return resolved;
        },
      };
    if (name === "request")
      return (config: { url: string; headers: unknown; body: unknown }) => {
        captured.url = config.url;
        captured.headers = config.headers;
        captured.body = config.body;
      };
    if (name === "unirest")
      return (_method: string, url: string) => {
        captured.url = url;
        return chain;
      };
    if (name === "follow-redirects") return { https: native, http: native };
    if (name === "https" || name === "http") return native;
    if (name === "fs") return {};
    throw new Error(`Unexpected dependency: ${name}`);
  };
  class Xhr {
    open(_method: string, url: string) {
      captured.url = url;
    }
    addEventListener() {}
    setRequestHeader() {}
    send(body: unknown) {
      captured.body = body;
    }
  }
  await new vm.Script(`(async () => { ${code}\n })()`).runInNewContext({
    require,
    atob,
    Headers,
    URLSearchParams,
    FormData,
    Buffer,
    console: { log() {}, error() {} },
    XMLHttpRequest: Xhr,
    fetch: (url: string, opts: { body: unknown; headers: unknown }) => {
      captured.url = url;
      captured.body = opts.body;
      captured.headers = opts.headers;
      return resolved;
    },
    $: {
      ajax: (config: { url: string; data: unknown; headers: unknown }) => {
        captured.url = config.url;
        captured.body = config.data;
        captured.headers = config.headers;
        return { done() {} };
      },
    },
  });
  return captured;
}

describe("code snippet target contract", () => {
  it("covers every maintained language/client plus C++ and keeps legacy IDs", () => {
    const pairs = CODEGEN_LANGUAGES.map((t) => `${t.language}/${t.variant}`);
    for (const language of generators.getLanguageList())
      for (const variant of language.variants) {
        expect(pairs).toContain(`${language.key}/${variant.key}`);
      }
    expect(CODEGEN_LANGUAGES).toHaveLength(36);
    expect(CODEGEN_LANGUAGES.map((t) => t.id)).toEqual(
      expect.arrayContaining(["curl", "fetch", "python", "powershell", "cpp-libcurl"]),
    );
  });

  it.each(CODEGEN_LANGUAGES)("generates $label with escaped raw data", async (target) => {
    const result = await generateCodeSnippet(target.id, request);
    expect(result.code.length).toBeGreaterThan(80);
    expect(result.code).not.toMatch(/pbx[a-f0-9]{32}x\d+x/);
    expect(result.code).toContain("Bearer");
    expect(result.warnings).toEqual([]);
  });

  it.each(javascript)("executes $label with exact payload/URL/auth", async (target) => {
    const result = await executeJs(target.id, request);
    expect(result.body).toBe(raw);
    expect(result.url).toBe(request.url);
    if (target.id !== "javascript-xhr") {
      const headers = result.headers instanceof Headers ? Object.fromEntries(result.headers) : result.headers;
      expect(JSON.stringify(headers)).toContain("Bearer");
    }
  });

  it.each(["python", "python-http-client"] as const)(
    "parses and executes %s with exact Unicode bytes",
    async (language) => {
      const { code } = await generateCodeSnippet(language, request);
      const harness = `import ast, sys, types, json\nsource = sys.stdin.read()\nast.parse(source)\nclass Reply:\n status_code=200\n text=''\n def read(self): return b''\n def getresponse(self): return self\n def request(self, method, path, body, headers): print(json.dumps({'body':body.decode('utf-8') if isinstance(body,bytes) else body, 'headers':headers}, ensure_ascii=False)); return self\nrequests=types.ModuleType('requests')\nrequests.request=lambda method,url,**kwargs: Reply().request(method,url,kwargs.get('data'),kwargs.get('headers'))\nsys.modules['requests']=requests\nimport http.client\nhttp.client.HTTPSConnection=lambda *a,**k: Reply()\nexec(source)\n`;
      const output = execFileSync("python3", ["-c", harness], { input: code, encoding: "utf8" });
      expect(JSON.parse(output.split("\n")[0]).body).toBe(raw);
    },
  );

  it.each(["curl", "postman-cli-postman-cli", "shell-httpie", "shell-wget"] as const)(
    "keeps shell body inert for %s",
    async (language) => {
      const body = raw.replaceAll("\0", "") + " $(touch /tmp/postbox-should-never-exist)";
      const { code } = await generateCodeSnippet(language, {
        ...request,
        body: { mode: "raw", language: "text", raw: body },
      });
      const script = `curl() { printf '%s\\0' "$@"; }; postman() { printf '%s\\0' "$@"; }; wget() { printf '%s\\0' "$@"; }; http() { cat; }; ${code}`;
      const output = execFileSync("sh", ["-c", script], { encoding: "utf8" });
      if (language === "shell-httpie") expect(output).toBe(body);
      else expect(output.split("\0")).toContain(body);
    },
  );

  it.each(javascript)("preserves duplicate form fields with $label", async (target) => {
    const result = await executeJs(target.id, {
      ...request,
      body: {
        mode: "urlencoded",
        urlencoded: [
          { key: "tag", value: "one", enabled: true },
          { key: "tag", value: "two & café", enabled: true },
          { key: "blank", value: "", enabled: true },
          { key: "off", value: "no", enabled: false },
        ],
      },
    });
    expect(result.body).toBe("tag=one&tag=two+%26+caf%C3%A9&blank=");
  });

  it("keeps raw HTTP Content-Length in bytes and GraphQL operationName", async () => {
    const { code } = await generateCodeSnippet("http-http", {
      ...request,
      body: {
        mode: "graphql",
        graphql: { query: "query café { x }", variables: '{"a":1}', operationName: "café" },
      },
    });
    const payload = code.split(/\r?\n\r?\n/)[1];
    expect(JSON.parse(payload).operationName).toBe("café");
    expect(code).toContain(`Content-Length: ${Buffer.byteLength(payload)}`);
  });

  it("preserves raw multiline body when changing shell indentation", async () => {
    const { code } = await generateCodeSnippet(
      "curl",
      { ...request, body: { mode: "raw", language: "text", raw: "one\n    two\nthree" } },
      { indentType: "Tab", indentCount: 1 },
    );
    expect(code).toContain("\\\n\t--header");
    expect(code).toContain("one\n    two\nthree");
  });

  it("applies target-specific options and rejects invalid/unsupported values", async () => {
    const { code } = await generateCodeSnippet("java-okhttp", request, {
      includeBoilerplate: true,
      indentType: "Tab",
      indentCount: 1,
      requestTimeout: 2000,
      followRedirect: false,
    });
    expect(code).toContain("import okhttp3");
    expect(code).toContain("\n\t");
    for (const options of [
      { indentCount: 0 },
      { indentCount: 100 },
      { indentType: "evil" },
      { requestTimeout: -1 },
      { includeBoilerplate: "true" },
      { unknown: true },
    ] as CodegenOptions[]) {
      await expect(generateCodeSnippet("java-okhttp", request, options)).rejects.toThrow();
    }
    await expect(generateCodeSnippet("fetch", request, { includeBoilerplate: true })).rejects.toThrow(
      "not supported",
    );
  });

  it("trims only when requested and warns on file setup/duplicate header limitations", async () => {
    const { code } = await generateCodeSnippet(
      "nodejs-axios",
      { ...request, body: { mode: "raw", language: "text", raw: "  body\n  " } },
      { trimRequestBody: true },
    );
    expect(code).toContain("'body'");
    const file = await generateCodeSnippet("c-libcurl", {
      ...request,
      headers: [...request.headers, ["authorization", "second"]],
      body: { mode: "binary", binary: { fileName: "a.bin", data: "AAE=" } },
    });
    expect(file.warnings.join(" ")).toMatch(/bytes are embedded/);
    expect(file.warnings.join(" ")).toMatch(/repeated header/);
    expect(file.code).not.toContain("<file contents here>");
    expect(file.code).toContain("CURLOPT_POSTFIELDSIZE, 2L");
  });
  it.each(javascript)("sends exact binary bytes with $label", async (target) => {
    const bytes = Buffer.from([0, 255, 128, 39, 34, 10, 92]);
    const result = await executeJs(target.id, {
      ...request,
      body: { mode: "binary", binary: { fileName: "input.bin", data: bytes.toString("base64") } },
    });
    expect(Buffer.from(result.body as Uint8Array)).toEqual(bytes);
  });

  it.each(javascript)("sends prepared multipart bytes with $label", async (target) => {
    const bytes = Buffer.from(
      '--fixture\r\nname="tag"\r\n\r\none\r\n--fixture\r\nname="tag"\r\n\r\ntwo\r\n--fixture--\r\n',
    );
    const result = await executeJs(target.id, {
      ...request,
      headers: [["Content-Type", "multipart/form-data; boundary=fixture"]],
      body: {
        mode: "formdata",
        formdata: [
          { key: "tag", value: "one", type: "text", enabled: true },
          { key: "tag", value: "two", type: "text", enabled: true },
        ],
      },
      bodyBytes: bytes,
    });
    expect(Buffer.from(result.body as Uint8Array)).toEqual(bytes);
  });

  it.each(["curl", "postman-cli-postman-cli", "shell-wget", "shell-httpie"] as const)(
    "sends binary bytes through %s without text conversion",
    async (language) => {
      const bytes = Buffer.from([0, 255, 128, 10, 39, 34, 92]);
      const { code } = await generateCodeSnippet(language, {
        ...request,
        body: { mode: "binary", binary: { fileName: "input.bin", data: bytes.toString("base64") } },
      });
      const stub =
        language === "shell-wget"
          ? 'wget() { while [ "$1" != "--body-file" ]; do shift; done; cat "$2"; }; '
          : language === "postman-cli-postman-cli"
            ? 'postman() { while [ "$1" != "--body" ]; do shift; done; cat "${2#@}"; }; '
            : language === "curl"
              ? "curl() { cat; }; "
              : "http() { cat; }; ";
      expect(execFileSync("sh", ["-c", stub + code])).toEqual(bytes);
    },
  );

  it.each(["python", "python-http-client"] as const)(
    "executes binary %s with exact bytes",
    async (language) => {
      const bytes = Buffer.from([0, 255, 128, 10, 39, 34, 92]);
      const { code } = await generateCodeSnippet(language, {
        ...request,
        body: { mode: "binary", binary: { fileName: "input.bin", data: bytes.toString("base64") } },
      });
      const harness = `import sys, types, json, base64\nclass Reply:\n status_code=200\n text=''\n def read(self): return b''\n def getresponse(self): return self\n def request(self, method, path, body, headers): print(base64.b64encode(body).decode()); return self\nrequests=types.ModuleType('requests')\nrequests.request=lambda method,url,**kwargs: Reply().request(method,url,kwargs.get('data'),kwargs.get('headers'))\nsys.modules['requests']=requests\nimport http.client\nhttp.client.HTTPSConnection=lambda *a,**k: Reply()\nexec(sys.stdin.read())\n`;
      const output = execFileSync("python3", ["-c", harness], { input: code, encoding: "utf8" });
      expect(output.split("\n")[0]).toBe(bytes.toString("base64"));
    },
  );

  it.each(CODEGEN_LANGUAGES)(
    "supports binary and multipart for $label without template placeholders",
    async (target) => {
      for (const body of [
        { mode: "binary", binary: { fileName: "a.bin", data: "AP8=" } },
        {
          mode: "formdata",
          formdata: [
            { key: "duplicate", value: "a", type: "text", enabled: true },
            { key: "duplicate", value: "b", type: "text", enabled: true },
            { key: "upload", value: "", type: "file", fileName: "a.bin", data: "AP8=", enabled: true },
          ],
        },
      ] as CodegenRequest["body"][]) {
        const { code } = await generateCodeSnippet(target.id, { ...request, body });
        expect(code).not.toMatch(/pbx[a-f0-9]{32}x\d+x|postboxByteBody|<file contents here>/);
      }
    },
  );

  it.each(["https://[::1]:8443/a?x=1&x=2", "http://127.0.0.1:1234/a", "{{baseUrl}}/a?x={{x}}"])(
    "preserves URL structure: %s",
    async (url) => {
      const { code } = await generateCodeSnippet("nodejs-axios", { ...request, url });
      expect(code).toContain(url);
    },
  );
  it("preserves local transport in cURL/Node and diagnoses other clients", async () => {
    const socketPath = "/tmp/postbox it'\"s.sock";
    const curl = await generateCodeSnippet("curl", { ...request, socketPath });
    expect(curl.code).toContain("--unix-socket");
    const native = await executeJs("nodejs-native", { ...request, socketPath });
    expect(native.socketPath).toBe(socketPath);
    const python = await generateCodeSnippet("python", { ...request, socketPath });
    expect(python.warnings.join(" ")).toContain("local socket");
  });
  it.skipIf(!hasCpp).each(["c-libcurl", "cpp-libcurl", "objective-c-nsurlsession"] as const)(
    "compiles %s payload literals without changing control characters or backslash-u text",
    async (language) => {
      const raw = "literal \\u0022 \\u2028 \\0 \b\f\v\t\r\n Unicode: café 日本語 🚀 \u2028";
      const { code } = await generateCodeSnippet(language, {
        ...request,
        body: { mode: "raw", language: "text", raw },
      });
      const literal =
        language === "objective-c-nsurlsession"
          ? code.match(/initWithData:\[@("(?:\\[\s\S]|[^"\\])*") dataUsingEncoding/)?.[1]
          : code.match(/const char \*data = (.*);/)?.[1];
      expect(literal).toBeTruthy();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-codegen-c-"));
      try {
        const source = path.join(dir, "payload.cpp"),
          binary = path.join(dir, "payload");
        fs.writeFileSync(
          source,
          `#include <cstdio>\nint main() {const char *data=${literal}; std::fwrite(data,1,${Buffer.byteLength(raw)},stdout);}`,
        );
        execFileSync("g++", [source, "-o", binary]);
        expect(execFileSync(binary)).toEqual(Buffer.from(raw));
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
