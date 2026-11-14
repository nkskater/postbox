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

  it("points the window at the server only once, so open tabs are never reloaded from storage", () => {
    const main = fs.readFileSync(path.join(TAURI, "src", "main.rs"), "utf8");
    const reader = main.slice(main.indexOf("strip_prefix(READY_PREFIX)"));
    const guard = reader.indexOf("if navigated");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(reader.indexOf(".navigate("));
    expect(main.match(/\.navigate\(/g)).toHaveLength(1);
  });

  it("saves downloads and opens app pop-ups inside the app (LAB-294)", () => {
    const conf = readJson(path.join(TAURI, "tauri.conf.json"));
    // The main window is built in code so it can carry the download and pop-up handlers.
    expect(conf.app.windows).toEqual([]);
    const main = fs.readFileSync(path.join(TAURI, "src", "main.rs"), "utf8");
    const builder = main.slice(main.indexOf("fn build_main_window"), main.indexOf("fn data_dir"));
    expect(builder).toContain('WebviewWindowBuilder::new(app, "main"');
    expect(builder).toContain('.title("Postbox")');
    expect(builder).toContain(".inner_size(1280.0, 800.0)");
    expect(builder).toContain(".min_inner_size(900.0, 600.0)");
    expect(builder).toContain(".on_download(handle_download)");
    expect(builder).toContain(".on_new_window(new_window_handler(");
    // Several downloads from the app need the "multiple downloads" permission, granted to app pages only.
    expect(builder).toContain(".on_permission_request(handle_permission)");
    expect(main).toContain("matches!(kind, PermissionKind::AutomaticDownloads) && app_page");
    expect(main).toMatch(/fn open_popup[\s\S]*\.on_download\(handle_download\)/);
    // Downloads go to the Downloads folder and never overwrite an existing file.
    expect(main).toContain(".download_dir()");
    expect(main).toContain('format!("{stem} ({n}){ext}")');
    // App pop-ups stay in the app (session cookie, window.opener); nothing else is allowed in.
    expect(main).toContain('url.as_str() == "about:blank" || is_app_url(&app, &url)');
    expect(main).toContain("main.origin() == url.origin()");

    // No plugin that would give pages file system, shell or dialog access. The updater is driven
    // from Rust only; the capability grants pages none of its commands.
    const cargo = fs.readFileSync(path.join(TAURI, "Cargo.toml"), "utf8");
    expect(cargo.match(/tauri-plugin-[\w-]+/g)?.sort()).toEqual([
      "tauri-plugin-single-instance",
      "tauri-plugin-updater",
      "tauri-plugin-window-state",
    ]);
  });

  it("checks for signed updates from GitHub Releases in the shell only (LAB-292)", () => {
    const conf = readJson(path.join(TAURI, "tauri.conf.json"));
    const updater = conf.plugins.updater;
    expect(updater.endpoints).toEqual([
      "https://github.com/nkskater/postbox/releases/latest/download/latest.json",
    ]);
    for (const endpoint of updater.endpoints) expect(new URL(endpoint).protocol).toBe("https:");
    expect(Buffer.from(updater.pubkey, "base64").toString("utf8")).toMatch(
      /^untrusted comment: minisign public key/,
    );
    expect(updater.requireSignedVersion).toBe(true);
    expect(updater).not.toHaveProperty("dangerousInsecureTransportProtocol");
    expect(updater.windows.installMode).toBe("passive");
    // Updater artifacts need the private key, so only CI turns them on (tags: project key).
    expect(conf.bundle.createUpdaterArtifacts ?? false).toBe(false);

    const capability = readJson(path.join(TAURI, "capabilities", "default.json"));
    expect(JSON.stringify(capability)).not.toContain("updater");

    // Every Rust source stays free of commands for pages.
    for (const file of fs.readdirSync(path.join(TAURI, "src"))) {
      const source = fs.readFileSync(path.join(TAURI, "src", file), "utf8");
      expect(source, file).not.toContain("tauri::command");
      expect(source, file).not.toContain("invoke_handler");
    }

    const update = fs.readFileSync(path.join(TAURI, "src", "update.rs"), "utf8");
    expect(update).toContain('env("POSTBOX_NO_UPDATE_CHECK").as_deref() == Some("1")');
    expect(update).toContain("Duration::from_secs(30)");
    expect(update).toContain("Duration::from_secs(24 * 60 * 60)");
    // Test overrides exist only in debug builds and the CI-only `update-test` feature.
    expect(update).toContain('if cfg!(any(debug_assertions, feature = "update-test"))');
    const cargo = fs.readFileSync(path.join(TAURI, "Cargo.toml"), "utf8");
    expect(cargo).toMatch(/\[features\]\s*(#.*\n)*update-test = \[\]/);
    expect(cargo).not.toMatch(/default\s*=\s*\[[^\]]*update-test/);
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
