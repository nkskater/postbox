import { describe, expect, it } from "vitest";
import { buildDigestAuthorization, parseDigestChallenge, type DigestChallenge } from "@/core/http/digest";

describe("parseDigestChallenge", () => {
  it("parses a full Digest challenge with realm, qop, nonce, opaque", () => {
    const header =
      'Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"';
    const result = parseDigestChallenge(header);
    expect(result).toEqual({
      realm: "testrealm@host.com",
      nonce: "dcd98b7102dd2f0e8b11d0f600bfb0c093",
      qop: "auth,auth-int",
      opaque: "5ccc069c403ebaf9f0171e9517f40e41",
      algorithm: undefined,
    });
  });

  it("parses unquoted algorithm=SHA-256", () => {
    const header = 'Digest realm="x", nonce="abc", algorithm=SHA-256';
    const result = parseDigestChallenge(header);
    expect(result).toEqual({
      realm: "x",
      nonce: "abc",
      qop: undefined,
      opaque: undefined,
      algorithm: "SHA-256",
    });
  });

  it("lowercase 'digest' scheme works", () => {
    const header = 'digest realm="testrealm@host.com", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093"';
    const result = parseDigestChallenge(header);
    expect(result).not.toBeNull();
    expect(result!.nonce).toBe("dcd98b7102dd2f0e8b11d0f600bfb0c093");
  });

  it("'Basic realm=\"x\"' returns null", () => {
    const result = parseDigestChallenge('Basic realm="x"');
    expect(result).toBeNull();
  });

  it("'Digest realm=\"x\"' without nonce returns null", () => {
    const result = parseDigestChallenge('Digest realm="x"');
    expect(result).toBeNull();
  });
});

describe("buildDigestAuthorization", () => {
  const challenge: DigestChallenge = {
    realm: "testrealm@host.com",
    nonce: "dcd98b7102dd2f0e8b11d0f600bfb0c093",
    qop: "auth,auth-int",
    opaque: "5ccc069c403ebaf9f0171e9517f40e41",
  };

  const opts = {
    username: "Mufasa",
    password: "Circle Of Life",
    method: "GET",
    uri: "/dir/index.html",
    cnonce: "0a4f113b",
    nc: 1,
  };

  it("RFC 2617 example produces correct response and fields", () => {
    const header = buildDigestAuthorization(challenge, opts);
    expect(header).toContain('response="6629fae49393a05397450978507c4ef1"');
    expect(header).toContain("qop=auth");
    expect(header).toContain("nc=00000001");
    expect(header).toContain('cnonce="0a4f113b"');
    expect(header).toContain('opaque="5ccc069c403ebaf9f0171e9517f40e41"');
  });

  it("without qop the header has no 'qop=' and no 'cnonce='", () => {
    const noQopChallenge: DigestChallenge = {
      realm: "testrealm@host.com",
      nonce: "dcd98b7102dd2f0e8b11d0f600bfb0c093",
    };
    const header = buildDigestAuthorization(noQopChallenge, opts);
    expect(header).not.toContain("qop=");
    expect(header).not.toContain("cnonce=");
  });

  it("algorithm 'SHA-256' gives a 64-hex-char response and contains 'algorithm=SHA-256'", () => {
    const shaChallenge: DigestChallenge = {
      realm: "testrealm@host.com",
      nonce: "dcd98b7102dd2f0e8b11d0f600bfb0c093",
      qop: "auth,auth-int",
      algorithm: "SHA-256",
    };
    const header = buildDigestAuthorization(shaChallenge, opts);
    expect(header).toMatch(/response="[0-9a-f]{64}"/);
    expect(header).toContain("algorithm=SHA-256");
  });

  it("algorithm 'MD5-sess' gives a different response than plain MD5 for the same inputs", () => {
    const md5Header = buildDigestAuthorization(challenge, opts);
    const sessChallenge: DigestChallenge = { ...challenge, algorithm: "MD5-sess" };
    const sessHeader = buildDigestAuthorization(sessChallenge, opts);
    const md5Match = /response="([0-9a-f]+)"/.exec(md5Header);
    const sessMatch = /response="([0-9a-f]+)"/.exec(sessHeader);
    expect(md5Match![1]).not.toEqual(sessMatch![1]);
  });

  it("without opaque the header has no 'opaque='", () => {
    const noOpaqueChallenge: DigestChallenge = {
      realm: "testrealm@host.com",
      nonce: "dcd98b7102dd2f0e8b11d0f600bfb0c093",
      qop: "auth,auth-int",
    };
    const header = buildDigestAuthorization(noOpaqueChallenge, opts);
    expect(header).not.toContain("opaque=");
  });
});
