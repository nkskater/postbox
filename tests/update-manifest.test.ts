import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { main, updateManifest } from "../scripts/write-update-manifest.mjs";

const url =
  "https://github.com/nkskater/postbox/releases/download/v1.2.3/Postbox-Desktop-windows-x64-setup.exe";

describe("desktop update manifest (LAB-292)", () => {
  it("has the shape the Tauri updater reads", () => {
    const manifest = updateManifest({
      version: "v1.2.3",
      url,
      signature: "c2lnbmF0dXJl\n",
      pubDate: new Date("2026-11-14T01:02:03.456Z"),
    });
    expect(manifest).toEqual({
      version: "1.2.3",
      notes: "Postbox 1.2.3: https://github.com/nkskater/postbox/releases/tag/v1.2.3",
      pub_date: "2026-11-14T01:02:03Z",
      platforms: { "windows-x86_64": { signature: "c2lnbmF0dXJl", url } },
    });
  });

  it("rejects a bad version, address or signature", () => {
    expect(() => updateManifest({ version: "latest", url, signature: "x" })).toThrow(/semantic version/);
    expect(() => updateManifest({ version: "1.0.0", url: "file:///C:/setup.exe", signature: "x" })).toThrow(
      /web address/,
    );
    expect(() => updateManifest({ version: "1.0.0", url, signature: " \n" })).toThrow(/signature is empty/);
  });

  it("writes latest.json and refuses a tag that does not match package.json", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-manifest-"));
    const sig = path.join(dir, "setup.exe.sig");
    fs.writeFileSync(sig, "c2ln");
    const pkg = path.join(dir, "package.json");
    fs.writeFileSync(pkg, JSON.stringify({ version: "1.2.3" }));
    const out = path.join(dir, "latest.json");
    main([
      "--version",
      "v1.2.3",
      "--url",
      url,
      "--signature-file",
      sig,
      "--out",
      out,
      "--expect-version-of",
      pkg,
    ]);
    expect(JSON.parse(fs.readFileSync(out, "utf8"))).toMatchObject({
      version: "1.2.3",
      platforms: { "windows-x86_64": { signature: "c2ln", url } },
    });
    expect(() =>
      main([
        "--version",
        "v1.2.4",
        "--url",
        url,
        "--signature-file",
        sig,
        "--out",
        out,
        "--expect-version-of",
        pkg,
      ]),
    ).toThrow(/does not match/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
