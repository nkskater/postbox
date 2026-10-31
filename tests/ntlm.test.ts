import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { createHmac } from "node:crypto";
import type { AddressInfo, Socket } from "node:net";
import {
  authenticateMessage,
  md4,
  negotiateMessage,
  ntlmv2Responses,
  ntowfv2,
  parseChallenge,
  splitUser,
} from "@/core/http/ntlm";
import { applyAuth, resolveAuth } from "@/core/http/auth";
import { sendRequest } from "@/core/http/engine";
import { exportPostmanCollection, importPostmanCollection } from "@/core/convert/postman";
import { authCredentialValues, withoutAuthCredentials } from "@/core/retention";
import { authSchema } from "@/core/schemas";
import { Resolver } from "@/core/variables/resolver";
import type { AuthConfig, PreparedRequest } from "@/core/types";
import { DEFAULT_SETTINGS } from "@/core/types";

const hex = (h: string) => Buffer.from(h, "hex");

describe("NTLM primitives", () => {
  it("implements MD4 (RFC 1320 test suite)", () => {
    expect(md4(Buffer.from("")).toString("hex")).toBe("31d6cfe0d16ae931b73c59d7e0c089c0");
    expect(md4(Buffer.from("abc")).toString("hex")).toBe("a448017aaf21d8525fc10ae87aa6729d");
    expect(md4(Buffer.from("message digest")).toString("hex")).toBe("d9130a8164549fe818874806e1c7014b");
    expect(md4(Buffer.from("1234567890".repeat(8))).toString("hex")).toBe("e33b4ddc9c38f2199c3e7b164fcc0536");
  });

  // MS-NLMP 4.2.2.1.2 and 4.2.4: User / Domain / Password, server challenge 0123456789abcdef.
  it("matches the MS-NLMP NTLMv2 example", () => {
    expect(md4(Buffer.from("Password", "utf16le")).toString("hex")).toBe("a4f49c406510bdcab6824ee7c30fd852");
    const key = ntowfv2("Password", "User", "Domain");
    expect(key.toString("hex")).toBe("0c868a403bfd7a93a3001ef22ef02e3f");
    const targetInfo = hex("02000c0044006f006d00610069006e0001000c0053006500720076006500720000000000");
    const r = ntlmv2Responses(
      key,
      hex("0123456789abcdef"),
      hex("aaaaaaaaaaaaaaaa"),
      Buffer.alloc(8),
      targetInfo,
    );
    expect(r.ntChallengeResponse.subarray(0, 16).toString("hex")).toBe("68cd0ab851e51c96aabc927bebef6a1c");
    expect(r.lmChallengeResponse.toString("hex")).toBe("86c35097ac9cec102554764a57cccc19aaaaaaaaaaaaaaaa");
  });

  it("splits DOMAIN\\user and parses only NTLM challenges", () => {
    expect(splitUser({ username: "CORP\\alice", password: "" })).toEqual({ user: "alice", domain: "CORP" });
    expect(splitUser({ username: "alice", password: "", domain: "X" })).toEqual({
      user: "alice",
      domain: "X",
    });
    expect(parseChallenge("Negotiate abc")).toBeNull();
    expect(parseChallenge(`NTLM ${negotiateMessage()}`)).toBeNull();
  });
});

/** A minimal NTLMv2 server: challenge per socket, verify the proof on the same socket. */
function ntlmServer(password: string) {
  const challenges = new WeakMap<Socket, Buffer>();
  const log: { url: string; step: string }[] = [];
  const server = http.createServer((req, res) => {
    const auth = req.headers.authorization ?? "";
    const m = /^NTLM (.+)$/.exec(auth);
    if (!m) {
      log.push({ url: req.url!, step: "none" });
      return res.writeHead(401, { "WWW-Authenticate": "NTLM" }).end();
    }
    const msg = Buffer.from(m[1], "base64");
    if (msg.readUInt32LE(8) === 1) {
      const serverChallenge = hex("0123456789abcdef");
      challenges.set(req.socket, serverChallenge);
      const type2 = Buffer.alloc(48);
      type2.write("NTLMSSP\0", "latin1");
      type2.writeUInt32LE(2, 8);
      type2.writeUInt32LE(0x00808205, 20);
      serverChallenge.copy(type2, 24);
      log.push({ url: req.url!, step: "negotiate" });
      return res.writeHead(401, { "WWW-Authenticate": `NTLM ${type2.toString("base64")}` }).end("challenge");
    }
    const serverChallenge = challenges.get(req.socket);
    const field = (i: number) =>
      msg.subarray(msg.readUInt32LE(16 + i * 8), msg.readUInt32LE(16 + i * 8) + msg.readUInt16LE(12 + i * 8));
    const nt = field(1);
    const domain = field(2).toString("utf16le");
    const user = field(3).toString("utf16le");
    const key = createHmac("md5", md4(Buffer.from(password, "utf16le")))
      .update(Buffer.from(user.toUpperCase() + domain, "utf16le"))
      .digest();
    const ok =
      !!serverChallenge &&
      createHmac("md5", key)
        .update(serverChallenge)
        .update(nt.subarray(16))
        .digest()
        .equals(nt.subarray(0, 16));
    log.push({ url: req.url!, step: ok ? `ok:${domain}\\${user}` : "bad" });
    if (!ok) return res.writeHead(401).end("denied");
    if (req.url === "/redirect") return res.writeHead(302, { Location: "/final" }).end();
    if (req.url === "/away") return res.writeHead(302, { Location: `${otherUrl}/x` }).end();
    res.end(`hello ${user}`);
  });
  return { server, log };
}

let otherUrl = "";
const seenElsewhere: (string | undefined)[] = [];
const other = http.createServer((req, res) => {
  seenElsewhere.push(req.headers.authorization);
  res.end("other");
});
const { server, log } = ntlmServer("s3cret");
let base = "";

beforeAll(async () => {
  await new Promise<void>((r) => other.listen(0, "127.0.0.1", r));
  otherUrl = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
  other.close();
});

async function send(path: string, auth: AuthConfig, method = "GET") {
  const req: PreparedRequest = { method, url: `${base}${path}`, headers: [], settings: DEFAULT_SETTINGS };
  await applyAuth(req, auth);
  return sendRequest(req);
}

describe("NTLM handshake over HTTP", () => {
  const auth: AuthConfig = { type: "ntlm", ntlm: { username: "CORP\\alice", password: "s3cret" } };

  it("authenticates on one connection", async () => {
    log.length = 0;
    const res = await send("/hello", auth);
    expect(res.status).toBe(200);
    expect(res.bodyText).toBe("hello alice");
    expect(log.map((l) => l.step)).toEqual(["negotiate", "ok:CORP\\alice"]);
  });

  it("returns the 401 for a wrong password without retrying forever", async () => {
    log.length = 0;
    const res = await send("/hello", {
      type: "ntlm",
      ntlm: { username: "alice", password: "nope", domain: "CORP" },
    });
    expect(res.status).toBe(401);
    expect(log.map((l) => l.step)).toEqual(["negotiate", "bad"]);
  });

  it("re-authenticates same-origin redirects and sends nothing cross-origin", async () => {
    log.length = 0;
    expect((await send("/redirect", auth)).bodyText).toBe("hello alice");
    expect(log.map((l) => `${l.url} ${l.step}`)).toEqual([
      "/redirect negotiate",
      "/redirect ok:CORP\\alice",
      "/final negotiate",
      "/final ok:CORP\\alice",
    ]);
    seenElsewhere.length = 0;
    expect((await send("/away", auth)).bodyText).toBe("other");
    expect(seenElsewhere).toEqual([undefined]);
  });

  it("works for requests with a body", async () => {
    const req: PreparedRequest = {
      method: "POST",
      url: `${base}/hello`,
      headers: [["Content-Type", "text/plain"]],
      body: Buffer.from("payload"),
      settings: DEFAULT_SETTINGS,
    };
    await applyAuth(req, auth);
    expect((await sendRequest(req)).status).toBe(200);
  });
});

describe("NTLM auth integration", () => {
  it("builds a Type 3 message the parser round-trips", () => {
    const challenge = parseChallenge(
      `NTLM ${Buffer.concat([Buffer.from("NTLMSSP\0", "latin1"), hex("02000000"), Buffer.alloc(8), hex("05828000"), hex("0123456789abcdef"), Buffer.alloc(16)]).toString("base64")}`,
    )!;
    const msg = Buffer.from(
      authenticateMessage({ username: "u", password: "p", domain: "D" }, challenge),
      "base64",
    );
    expect(msg.subarray(0, 8).toString("latin1")).toBe("NTLMSSP\0");
    expect(msg.readUInt32LE(8)).toBe(3);
  });

  it("resolves variables, validates, round-trips Postman ntlm and keeps the password out", () => {
    const resolved = resolveAuth(
      { type: "ntlm", ntlm: { username: "{{u}}", password: "{{p}}", domain: "D" } },
      new Resolver({
        globals: { u: "alice", p: "pw" },
        environment: {},
        collection: {},
        data: {},
        local: {},
      }),
    );
    expect(resolved).toEqual({
      type: "ntlm",
      ntlm: { username: "alice", password: "pw", domain: "D", workstation: undefined },
    });
    expect(authSchema.parse(resolved)).toMatchObject({ type: "ntlm" });
    const col = importPostmanCollection({
      info: { name: "c", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
      auth: {
        type: "ntlm",
        ntlm: [
          { key: "username", value: "alice" },
          { key: "password", value: "PWSECRET" },
          { key: "domain", value: "CORP" },
          { key: "workstation", value: "WS1" },
        ],
      },
      item: [],
    } as never);
    expect(col.root.auth).toEqual({
      type: "ntlm",
      ntlm: { username: "alice", password: "PWSECRET", domain: "CORP", workstation: "WS1" },
    });
    expect(JSON.stringify(exportPostmanCollection(col.root))).not.toContain("PWSECRET");
    expect(authCredentialValues(col.root.auth)).toEqual(["PWSECRET"]);
    expect(JSON.stringify(withoutAuthCredentials(col.root.auth))).not.toContain("PWSECRET");
  });
});
