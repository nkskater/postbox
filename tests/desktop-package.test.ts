import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");
const TAURI = path.join(ROOT, "desktop", "src-tauri");

function readJson(file: string) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

describe("Windows desktop package", () => {
  it("builds only a per-user NSIS installer with the fixed identity", () => {
    const conf = readJson(path.join(TAURI, "tauri.conf.json"));
    expect(conf.productName).toBe("Postbox Desktop");
    expect(conf.mainBinaryName).toBe("postbox-desktop");
    expect(conf.identifier).toBe("io.github.nkskater.postbox");
    expect(conf.bundle.targets).toEqual(["nsis"]);
    expect(conf.bundle.windows.nsis.installMode).toBe("currentUser");
    expect(conf.bundle.windows.nsis.installerHooks).toBe("./windows/hooks.nsh");
    expect(conf.bundle.resources).toMatchObject({
      "../payload/app/": "app/",
      "../payload/runtime/postbox-node.exe": "runtime/postbox-node.exe",
    });
  });

  it("gives pages no access to the shell", () => {
    const conf = readJson(path.join(TAURI, "tauri.conf.json"));
    expect(conf.app.withGlobalTauri).toBe(false);
    expect(conf.app.security.capabilities).toEqual(["default"]);

    const capability = readJson(path.join(TAURI, "capabilities", "default.json"));
    expect(capability.permissions).toEqual([]);
    expect(capability).not.toHaveProperty("remote");
    expect(fs.readdirSync(path.join(TAURI, "capabilities"))).toEqual(["default.json"]);

    const main = fs.readFileSync(path.join(TAURI, "src", "main.rs"), "utf8");
    expect(main).toContain("POSTBOX_HOST_PIPE");
    expect(main).not.toContain("tauri::command");
    expect(main).not.toContain("invoke_handler");
  });

  it("keeps the installer hooks free of machine-wide changes", () => {
    const hooks = fs.readFileSync(path.join(TAURI, "windows", "hooks.nsh"), "utf8");
    for (const banned of ["HKLM", "RequestExecutionLevel", "sc.exe", "schtasks"]) {
      expect(hooks.toLowerCase()).not.toContain(banned.toLowerCase());
    }
    expect(hooks).toContain("postbox-node.exe");
    expect(hooks).toContain('RMDir /r "$LOCALAPPDATA\\Postbox"');
  });

  it("pins the Tauri CLI and keeps it out of the root package", () => {
    const desktopPkg = readJson(path.join(ROOT, "desktop", "package.json"));
    expect(desktopPkg.devDependencies["@tauri-apps/cli"]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(fs.existsSync(path.join(ROOT, "desktop", "package-lock.json"))).toBe(true);
    expect(fs.existsSync(path.join(TAURI, "Cargo.lock"))).toBe(true);

    const rootPkg = readJson(path.join(ROOT, "package.json"));
    expect(rootPkg.scripts["build:desktop"]).toBe("node scripts/build-desktop.mjs");
    const rootDeps = { ...rootPkg.dependencies, ...rootPkg.devDependencies };
    expect(Object.keys(rootDeps).filter((d) => d.startsWith("@tauri-apps/"))).toEqual([]);
  });
});
