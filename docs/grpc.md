# gRPC

Postbox calls gRPC methods server-side (unary, client-streaming, server-streaming and
bidirectional) against definitions you supply with the request. This page covers the
automation interface; the request editor and server reflection are tracked separately.

## Definitions

A request's `settings.grpc` holds the definitions and the method to call:

```json
{
  "url": "grpc://localhost:50051",
  "settings": {
    "grpc": {
      "protos": { "echo.proto": "syntax = \"proto3\"; package test; ..." },
      "service": "test.Echo",
      "method": "Unary"
    }
  }
}
```

- `grpc://` is plaintext, `grpcs://` is TLS (certificate verification follows the request's
  **Verify SSL** setting).
- `protos` maps file names to `.proto` text. Imports resolve only against these files and
  the bundled well-known types (`google/protobuf/*.proto`); nothing is read from disk.
  Limits: 50 files, 1 MiB in total.
- `service` may be fully qualified (`test.Echo`) or the bare name when unambiguous.

## Calling a method

`POST /api/grpc` with `{ workspaceId, environmentId?, folderId?, request }`. The request body
(raw JSON) is the message; for client-streaming and bidirectional methods it is an array of
messages. Variables, folder headers and authentication apply as for HTTP requests. Request
headers become call metadata (names are lowercased; `-bin` keys take base64 values; HTTP
transport headers and `grpc-*` names are dropped). Digest, NTLM and AWS Signature
authentication are not available for gRPC.

JSON mapping: `int64`/`uint64` are strings, `bytes` are base64, enums are names. Unknown
field names and mistyped values are rejected before anything is sent.

Setup problems (bad definitions, invalid message, blocked host, unsupported URL) return
HTTP 400 with `{ "error": "..." }`. Otherwise the response is NDJSON, one event per line:

| `type`     | Fields                                                             |
| ---------- | ------------------------------------------------------------------ |
| `open`     | `target`, `method` (path, request/response types, streaming flags) |
| `sent`     | `index`, `message` (client-streaming calls)                        |
| `metadata` | `metadata`: `[name, value][]` (response headers)                   |
| `message`  | `index`, `message`, `size`                                         |
| `status`   | `code`, `codeName`, `details`, `trailers`                          |
| `error`    | `error` (for example the response limit)                           |
| `done`     | always last                                                        |

A non-OK gRPC outcome (including connection failure and deadline) is reported as a `status`
event with its code, not an HTTP error. The request's **Timeout** is the call deadline;
closing the connection cancels the call. Responses stop at 1000 messages or 8 MiB.

The target host is resolved and checked against `PROXY_ALLOW_HOSTS`/`PROXY_DENY_HOSTS`
before connecting to the vetted address, and environment proxies are not used.

## Describing definitions

`POST /api/grpc/describe` with `{ workspaceId, protos }` returns
`{ services: [{ name, fullName, methods: [{ name, path, requestType, responseType, clientStreaming, serverStreaming }] }] }`
without any network access.
