import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { HostPolicy, HostPolicyError, normalizeSocketPath } from "@/core/http/policy";
import { sendRequest } from "@/core/http/engine";
import { prepareRequest } from "@/core/http/prepare";
import { Resolver, emptyScopes } from "@/core/variables/resolver";
import { settingsPatchSchema } from "@/core/schemas";
import type { PreparedRequest } from "@/core/types";
import { DEFAULT_SETTINGS } from "@/core/types";

const unix = process.platform !== "win32";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-uds-"));
const sock = path.join(dir, "api.sock");
const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-uds-outside-"));
const other = path.join(outsideDir, "other.sock");
const link = path.join(dir, "link.sock");
const seen: { socket: string; url?: string; host?: string; auth?: string }[] = [];
const servers: http.Server[] = [];
let tcpUrl = "";

function serve(where: string | number, name: string) {
  const server = http.createServer((req, res) => {
    seen.push({ socket: name, url: req.url, host: req.headers.host, auth: req.headers.authorization });
    if (req.url === "/redirect") return res.writeHead(302, { Location: "/final" }).end();
    if (req.url === "/away") return res.writeHead(302, { Location: `${tcpUrl}/tcp` }).end();
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ via: name, path: req.url, host: req.headers.host }));
  });
  servers.push(server);
  return new Promise<void>((resolve) => server.listen(where as number, resolve));
}

beforeAll(async () => {
  if (!unix) return;
  await serve(sock, "api");
  await serve(other, "other");
  fs.symlinkSync(other, link);
  await serve(0, "tcp");
  tcpUrl = `http://127.0.0.1:${(servers[2].address() as AddressInfo).port}`;
});
afterAll(() => {
  for (const s of servers) s.close();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(outsideDir, { recursive: true, force: true });
});

const request = (url: string, socketPath?: string): PreparedRequest => ({
  method: "GET",
  url,
  headers: [["Authorization", "Bearer t"]],
  settings: { ...DEFAULT_SETTINGS, socketPath },
});

describe("socket policy", () => {
  it("denies every socket by default", () => {
    expect(new HostPolicy().checkSocket("/var/run/docker.sock")).toMatch(/not in PROXY_ALLOW_SOCKETS/);
    expect(new HostPolicy().checkSocket("relative.sock")).toMatch(/absolute path/);
  });

  it("validates allowlist entries", () => {
    expect(() => new HostPolicy([], [], ["relative.sock"])).toThrow(HostPolicyError);
    expect(() => new HostPolicy([], [], ["\\\\.\\pipe\\*"])).toThrow(HostPolicyError);
  });

  it("normalizes named pipes case-insensitively", () => {
    expect(normalizeSocketPath("\\\\?\\PIPE\\Docker_Engine")).toBe("\\\\.\\pipe\\docker_engine");
    const policy = new HostPolicy([], [], ["\\\\.\\pipe\\docker_engine"]);
    expect(policy.checkSocket("\\\\.\\PIPE\\Docker_Engine")).toBeNull();
    expect(policy.checkSocket("\\\\.\\pipe\\other")).toMatch(/not in/);
  });

  it.runIf(unix)("matches exact paths and dir/* and resolves symlinks", () => {
    expect(new HostPolicy([], [], [sock]).checkSocket(sock)).toBeNull();
    expect(new HostPolicy([], [], [`${dir}/*`]).checkSocket(sock)).toBeNull();
    expect(new HostPolicy([], [], [`${dir}/*`]).checkSocket(path.join(dir, "nested", "x.sock"))).toMatch(/not in/);
    // The link sits in the allowed directory but points at a socket outside it.
    expect(new HostPolicy([], [], [`${dir}/*`]).checkSocket(link)).toMatch(/not in/);
    expect(new HostPolicy([], [], [other]).checkSocket(link)).toBeNull();
  });
});

describe.runIf(unix)("requests over a Unix socket", () => {
  const policy = () => new HostPolicy([], [], [sock, other]);

  it("sends the URL path and Host header over the socket", async () => {
    const res = await sendRequest(request("http://api.local/v1/status?x=1", sock), { policy: policy() });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.bodyText)).toEqual({ via: "api", path: "/v1/status?x=1", host: "api.local" });
  });

  it("refuses sockets outside the allowlist before connecting", async () => {
    await expect(sendRequest(request("http://localhost/", sock))).rejects.toThrow(/PROXY_ALLOW_SOCKETS/);
  });

  it("keeps the socket for same-origin redirects and leaves it for other origins", async () => {
    seen.length = 0;
    const same = await sendRequest(request("http://api.local/redirect", sock), { policy: policy() });
    expect(JSON.parse(same.bodyText).via).toBe("api");
    seen.length = 0;
    const away = await sendRequest(request("http://api.local/away", sock), { policy: policy() });
    expect(JSON.parse(away.bodyText).via).toBe("tcp");
    expect(seen.map((s) => s.socket)).toEqual(["api", "tcp"]);
    expect(seen[1].auth).toBeUndefined();
  });

  it("resolves variables in the socket path and validates the setting", async () => {
    const { prepared } = await prepareRequest(
      {
        id: "r",
        name: "r",
        method: "GET",
        url: "http://api.local/",
        params: [],
        headers: [],
        body: { mode: "none" },
        auth: { type: "none" },
        preRequestScript: "",
        testScript: "",
        settings: { ...DEFAULT_SETTINGS, socketPath: "{{sockDir}}/api.sock" },
      },
      [],
      new Resolver({ ...emptyScopes(), globals: { sockDir: dir } }),
    );
    expect(prepared.settings.socketPath).toBe(sock);
    expect((await sendRequest(prepared, { policy: policy() })).status).toBe(200);
    expect(settingsPatchSchema.parse({ socketPath: "/run/x.sock" })).toEqual({ socketPath: "/run/x.sock" });
  });
});
