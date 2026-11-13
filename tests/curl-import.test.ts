import { describe, expect, it } from "vitest";
import { isCmdStyle, parseCurl, tokenizeCmd } from "@/core/convert/curl";

describe("cURL import: Windows cmd, unknown options and file bodies", () => {
  it("imports Chrome's 'Copy as cURL (cmd)' output", () => {
    const cmd = [
      'curl ^"https://a.test/^" ^',
      '  -H ^"accept: */*^" ^',
      '  --data-raw ^"^{^\\^"a^\\^":1^}^"',
    ].join("\n");
    expect(isCmdStyle(cmd)).toBe(true);
    const r = parseCurl(cmd);
    expect(r.url).toBe("https://a.test/");
    expect(r.headers).toContainEqual({ key: "accept", value: "*/*", enabled: true });
    expect(r.body).toEqual({ mode: "raw", raw: JSON.stringify({ a: 1 }, null, 2), language: "json" });
    expect(r.method).toBe("POST");
    expect(r.warnings).toEqual([]);
  });

  it("accepts curl.exe and Windows argument quoting", () => {
    const r = parseCurl('curl.exe ^"https://a.test/^" -H ^"X: 1^"');
    expect(r.url).toBe("https://a.test/");
    expect(r.headers).toEqual([{ key: "X", value: "1", enabled: true }]);
    expect(parseCurl("curl.exe https://a.test/x").url).toBe("https://a.test/x");
    // "" inside quotes is a literal quote; backslashes before a quote follow the C runtime rules.
    expect(tokenizeCmd('curl "say ""hi""" "a\\\\" "b\\"c"')).toEqual(["curl", 'say "hi"', "a\\", 'b"c']);
  });

  it("never takes an option's value as the URL", () => {
    const r = parseCurl('curl --aws-sigv4 "aws:amz:us-east-1:s3" -u KEY:SECRET https://a.test');
    expect(r.url).toBe("https://a.test");
    expect(r.auth).toEqual({
      type: "awsv4",
      awsv4: { accessKey: "KEY", secretKey: "SECRET", region: "us-east-1", service: "s3" },
    });

    const unknown = parseCurl("curl --some-new-option value https://a.test/ok");
    expect(unknown.url).toBe("https://a.test/ok");
    expect(unknown.warnings).toContain("ignored option --some-new-option");
    // A flag without a value directly before the URL still leaves the URL alone.
    expect(parseCurl("curl --some-flag https://a.test/ok").url).toBe("https://a.test/ok");
  });

  it("takes the AWS region and service from the host when the provider string has none", () => {
    const r = parseCurl("curl --aws-sigv4 aws:amz -u K:S https://abc.execute-api.eu-west-1.amazonaws.com/x");
    expect(r.auth).toMatchObject({ type: "awsv4", awsv4: { region: "eu-west-1", service: "execute-api" } });
  });

  it("marks bodies read from files as missing instead of sending the file name", () => {
    const json = parseCurl("curl -d @body.json -H 'Content-Type: application/json' https://a.test");
    expect(json.body).toEqual({
      mode: "binary",
      binary: { fileName: "body.json", contentType: "application/json", data: "", missing: true },
    });
    expect(json.warnings).toContain("body comes from file body.json (attach it)");
    expect(json.method).toBe("POST");

    const bin = parseCurl("curl --data-binary @body.bin https://a.test");
    expect(bin.body).toMatchObject({ mode: "binary", binary: { fileName: "body.bin", missing: true } });

    // --data-raw does not read files.
    expect(parseCurl("curl --data-raw @literal https://a.test").body).toMatchObject({ mode: "urlencoded" });
  });

  it("reports uploads, extra URLs and maps --url-query and --max-time", () => {
    const upload = parseCurl("curl -T ./file.bin https://a.test/up");
    expect(upload.method).toBe("PUT");
    expect(upload.body).toMatchObject({ mode: "binary", binary: { fileName: "file.bin", missing: true } });
    expect(upload.warnings).toContain("upload file ./file.bin was not imported (attach it)");

    expect(parseCurl('curl --url-query "c=3" "https://a.test/?a=1"').url).toBe("https://a.test/?a=1&c=3");
    expect(parseCurl("curl --url-query 'q=a b' https://a.test/").url).toBe("https://a.test/?q=a%20b");
    expect(parseCurl("curl --max-time 5 https://a.test").timeoutMs).toBe(5000);

    const two = parseCurl("curl https://a.test/a https://a.test/b");
    expect(two.url).toBe("https://a.test/a");
    expect(two.warnings).toContain("only the first URL was imported (also given: https://a.test/b)");
  });

  it("expands combined short flags", () => {
    const r = parseCurl("curl -sSLk -XPOST https://a.test");
    expect(r).toMatchObject({ method: "POST", followRedirects: true, insecure: true, warnings: [] });
  });
});
