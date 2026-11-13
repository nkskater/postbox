import { describe, expect, it } from "vitest";
import {
  exportPostmanCollection,
  importPostmanCollection,
  type PostmanCollection,
} from "@/core/convert/postman";
import { postmanV21ToV3 } from "@/core/convert/postman-v3";
import type { FolderNode, RequestNode, RequestSettings } from "@/core/types";

/**
 * Every RequestSettings key with a non-default value. `Required` makes this fail to compile
 * when a new setting is added, so the round trip below has to account for it.
 */
const ALL_SETTINGS: Required<RequestSettings> = {
  followRedirects: false,
  maxRedirects: 3,
  timeoutMs: 1234,
  verifySsl: false,
  useCookieJar: false,
  socketPath: "/var/run/api.sock",
  httpVersion: "http2",
  socketio: { namespace: "/chat", path: "/io", listeners: ["message"], ackTimeoutMs: 500 },
  mqtt: {
    clientId: "c1",
    protocolVersion: 5,
    clean: false,
    keepalive: 30,
    subscriptions: [{ topic: "t", qos: 1 }],
  },
  grpc: { protos: { "a.proto": "syntax = 'proto3';" }, service: "a.S", method: "Do", reflection: false },
};

function request(over: Partial<RequestNode>): RequestNode {
  return {
    kind: "request",
    id: over.name ?? "r",
    name: "r",
    method: "GET",
    url: "https://api.test/items",
    params: [],
    headers: [],
    body: { mode: "none" },
    auth: { type: "inherit" },
    preRequestScript: "",
    testScript: "",
    settings: {
      followRedirects: true,
      maxRedirects: 10,
      timeoutMs: 30000,
      verifySsl: true,
      useCookieJar: true,
    },
    examples: [],
    ...over,
  };
}

function roundTrip(children: RequestNode[]): RequestNode[] {
  const root: FolderNode = {
    kind: "folder",
    id: "root",
    name: "Fidelity",
    auth: { type: "none" },
    headers: [],
    preRequestScript: "",
    testScript: "",
    children,
  };
  const exported = exportPostmanCollection(root, [], { includeSecrets: true, includeCredentials: true });
  const imported = importPostmanCollection(JSON.parse(JSON.stringify(exported)) as PostmanCollection);
  return imported.root.children as RequestNode[];
}

describe("Postman export and import keep request details", () => {
  it("keeps every request setting", () => {
    const [back] = roundTrip([request({ name: "settings", settings: ALL_SETTINGS })]);
    expect(back.settings).toEqual(ALL_SETTINGS);
    for (const key of Object.keys(ALL_SETTINGS) as (keyof RequestSettings)[])
      expect(back.settings[key], key).toEqual(ALL_SETTINGS[key]);
  });

  it("keeps default settings out of the exported file", () => {
    const root: FolderNode = {
      kind: "folder",
      id: "root",
      name: "Defaults",
      auth: { type: "none" },
      headers: [],
      preRequestScript: "",
      testScript: "",
      children: [request({ name: "plain" })],
    };
    const item = exportPostmanCollection(root).item[0] as Record<string, unknown>;
    expect(item.protocolProfileBehavior).toBeUndefined();
    expect(item._postbox).toBeUndefined();
  });

  it("keeps the bearer prefix, the binary content type and parameter and header descriptions", () => {
    const [bearer, binary, described] = roundTrip([
      request({ name: "bearer", auth: { type: "bearer", bearer: { token: "t", prefix: "Token" } } }),
      request({
        name: "binary",
        method: "POST",
        body: {
          mode: "binary",
          binary: { fileName: "a.bin", contentType: "application/x-foo", data: "AAAA" },
        },
      }),
      request({
        name: "described",
        url: "https://api.test/items?on=1",
        params: [
          { key: "on", value: "1", enabled: true, description: "kept" },
          { key: "off", value: "x", enabled: false, description: "d" },
        ],
        headers: [
          { key: "X-On", value: "1", enabled: true, description: "on header" },
          { key: "X", value: "2", enabled: false, description: "hd" },
        ],
      }),
    ]);
    expect(bearer.auth).toEqual({ type: "bearer", bearer: { token: "t", prefix: "Token" } });
    // File bytes are not exported; the file name and content type are.
    expect(binary.body).toEqual({
      mode: "binary",
      binary: { fileName: "a.bin", contentType: "application/x-foo", data: "", missing: true },
    });
    expect(described.params).toEqual([
      { key: "on", value: "1", enabled: true, description: "kept" },
      { key: "off", value: "x", enabled: false, description: "d" },
    ]);
    expect(described.headers).toEqual([
      { key: "X-On", value: "1", enabled: true, description: "on header" },
      { key: "X", value: "2", enabled: false, description: "hd" },
    ]);
  });

  it("reads Postman's own protocolProfileBehavior", () => {
    const fromPostman: PostmanCollection = {
      info: {
        name: "From Postman",
        schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
      },
      item: [
        {
          name: "Internal",
          protocolProfileBehavior: { followRedirects: false, strictSSL: false, disableBodyPruning: true },
          request: { method: "GET", url: "https://internal.test/" },
        },
      ],
    } as never;
    const [req] = importPostmanCollection(fromPostman).root.children as RequestNode[];
    expect(req.settings).toMatchObject({ followRedirects: false, verifySsl: false, maxRedirects: 10 });
  });

  it("ignores settings an imported file cannot set", () => {
    const crafted = {
      info: {
        name: "Crafted",
        schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
      },
      item: [
        {
          name: "x",
          _postbox: { settings: { timeoutMs: -5, httpVersion: "spdy", unknownKey: true } },
          request: { method: "GET", url: "https://a.test/" },
        },
      ],
    } as never;
    const [req] = importPostmanCollection(crafted).root.children as RequestNode[];
    expect(req.settings).toEqual({
      followRedirects: true,
      maxRedirects: 10,
      timeoutMs: 30000,
      verifySsl: true,
      useCookieJar: true,
    });
  });

  it("reports settings that v3 cannot hold", () => {
    const root: FolderNode = {
      kind: "folder",
      id: "root",
      name: "V3",
      auth: { type: "none" },
      headers: [],
      preRequestScript: "",
      testScript: "",
      children: [request({ name: "strict", settings: { ...ALL_SETTINGS } })],
    };
    const { diagnostics } = postmanV21ToV3(exportPostmanCollection(root));
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        level: "lossy",
        path: "V3 / strict",
        message: expect.stringContaining("settings"),
      }),
    );
  });
});
