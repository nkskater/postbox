# Request code snippets

Postbox generates single-request snippets for all 35 language/client pairs in the
[Postman documentation](https://learning.postman.com/docs/use/send-requests/create-requests/generate-code-snippets)
checked on 2026-10-31, plus a C++ libcurl target. The explicit catalog is
`src/core/convert/codegen-targets.ts`. Existing IDs remain compatible.

The extended adapters use the Apache-2.0 licensed
[postman-code-generators 2.1.1](https://github.com/postmanlabs/postman-code-generators)
and Postman Collection SDK 5.3.1. cURL, Fetch, Requests and PowerShell retain
Postbox's existing generators. C++ uses the C-compatible libcurl API.

| Target ID                  | Language / client          |
| -------------------------- | -------------------------- |
| `curl`                     | cURL – cURL                |
| `fetch`                    | JavaScript – Fetch         |
| `python`                   | Python – Requests          |
| `powershell`               | PowerShell – RestMethod    |
| `c-libcurl`                | C – libcurl                |
| `csharp-httpclient`        | C# – HttpClient            |
| `csharp-restsharp`         | C# – RestSharp             |
| `cpp-libcurl`              | C++ – libcurl              |
| `dart-dio`                 | Dart – dio                 |
| `dart-http`                | Dart – http                |
| `go-native`                | Go – Native                |
| `http-http`                | HTTP – HTTP                |
| `java-okhttp`              | Java – OkHttp              |
| `java-unirest`             | Java – Unirest             |
| `javascript-jquery`        | JavaScript – jQuery        |
| `javascript-xhr`           | JavaScript – XHR           |
| `kotlin-okhttp`            | Kotlin – Okhttp            |
| `nodejs-axios`             | NodeJs – Axios             |
| `nodejs-native`            | NodeJs – Native            |
| `nodejs-request`           | NodeJs – Request           |
| `nodejs-unirest`           | NodeJs – Unirest           |
| `objective-c-nsurlsession` | Objective-C – NSURLSession |
| `ocaml-cohttp`             | OCaml – Cohttp             |
| `php-curl`                 | PHP – cURL                 |
| `php-guzzle`               | PHP – Guzzle               |
| `php-http-request2`        | PHP – HTTP_Request2        |
| `php-pecl-http`            | PHP – pecl_http            |
| `postman-cli-postman-cli`  | Postman CLI – Postman CLI  |
| `python-http-client`       | Python – http.client       |
| `r-httr`                   | R – httr                   |
| `r-rcurl`                  | R – RCurl                  |
| `ruby-net-http`            | Ruby – Net::HTTP           |
| `rust-reqwest`             | Rust – reqwest             |
| `shell-httpie`             | Shell – Httpie             |
| `shell-wget`               | Shell – wget               |
| `swift-urlsession`         | Swift – URLSession         |

## Settings and automation

Open **Code snippet** on a request, choose the target and expand **Code settings**.
Each target advertises its own settings: indentation, boilerplate, timeout,
redirects, body trimming or asynchronous style where implemented by that client.
The UI resets settings on target changes and prevents copying stale generation
results. Resolved snippets can contain credentials; file bodies embed upload bytes.

Authenticated `GET /api/codegen` and the MCP `list_code_snippet_targets` tool
return `{ targets: [...] }`, including target IDs, option IDs, types, defaults
and enum choices. Send a target's ID as `language` and optional settings as
`options` to `POST /api/codegen` or MCP `generate_code_snippet`. Unknown targets,
unsupported options, invalid enums and out-of-range numbers are rejected.
Indentation accepts 1–8 characters; timeouts accept 0–3,600,000 milliseconds.
The REST result includes `code` and `warnings`; MCP preserves its `snippet` field
and adds `warnings`. Existing callers can omit `options`.

For example, an existing codegen request can add:

```json
{
  "language": "java-okhttp",
  "options": {
    "includeBoilerplate": true,
    "indentType": "Tab",
    "indentCount": 1,
    "requestTimeout": 10000
  }
}
```

## Request fidelity and client prerequisites

- URL, inherited headers/auth and selected variables use the same offline request
  preparation as sending. MCP also uses the resolved body. Code generation does
  not execute scripts, send requests or acquire OAuth tokens. Challenge-based
  Digest/NTLM auth requires the generated client's credential configuration;
  missing OAuth tokens and time-sensitive signature snapshots produce warnings.
- Raw payload formatting is preserved unless body trimming is explicitly enabled.
  Form encoding retains order, duplicate names and empty values. Multipart and
  binary bodies use exact prepared bytes, including the boundary paired with
  the Content-Type header. Files do not require hand-filled content placeholders.
  Text-mode Python clients send UTF-8 bytes.
- Raw HTTP is a text preview. Its binary bodies are labelled as base64 and produce
  an explicit decoding warning. Header maps in some third-party clients combine
  duplicate names; duplicate input headers produce a warning.
- Shell snippets target POSIX sh with `base64 -d`. wget and Postman CLI create
  a temporary body file and remove it on exit. Shell quoting/continuation settings
  for other shells are intentionally not advertised. PowerShell is a separate target.
- Local socket transport is retained for cURL (Unix sockets) and Node Native
  (Unix sockets or named pipes). Other targets warn that client transport setup
  is required.
- Snippets assume the selected runtime and client libraries are installed. Browser
  snippets need the target's CORS permission. Node snippets use CommonJS. Some
  targets are statements intended for an existing program; enable boilerplate
  when that target exposes it. Postbox does not install libraries or send a
  generated request automatically.

## Verification

Tests exercise every target with adversarial text and binary/multipart bodies.
JavaScript is parsed and executed with fake clients, Python snippets are parsed
and executed with fake transports, and shell snippets run against command stubs.
These verify the actual URL, auth and body arguments, including repeated form
fields, NUL/non-UTF-8 bytes and multiline Unicode. REST/MCP tests cover discovery,
option validation, variable resolution, inherited auth and prepared boundaries.
They are representative syntax/runtime checks; CI does not install every
third-party language toolchain or contact real APIs.
