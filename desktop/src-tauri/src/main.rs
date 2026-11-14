// Postbox Desktop: a native window around the bundled local server.
//
// The shell starts `runtime\postbox-node.exe app\local.mjs` in host mode
// (POSTBOX_HOST_PIPE=1), waits for its single POSTBOX_READY line and points the
// window at the loopback URL it reports. Closing stdin tells the server to stop,
// so the server also stops when this process dies. No commands are exposed to
// pages: everything the window shows is the regular web UI.
//
// Updates are checked in update.rs.
//
// The shell saves downloads to the Downloads folder (never overwriting a file)
// and confirms each one, and opens pop-ups from the app (exports, the OAuth
// sign-in window) as windows of its own so they keep the session and opener.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

mod update;

use serde_json::{json, Value};
use tauri::webview::{
    DownloadEvent, NewWindowFeatures, NewWindowResponse, PermissionKind, PermissionResponse,
};
use tauri::{
    AppHandle, Manager, RunEvent, Url, Webview, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

const READY_PREFIX: &str = "POSTBOX_READY ";
const ERROR_PREFIX: &str = "POSTBOX_ERROR ";
const READY_TIMEOUT: Duration = Duration::from_secs(90);
const STOP_TIMEOUT: Duration = Duration::from_secs(8);
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// The server process owned by this window, if any.
#[derive(Default)]
struct Server {
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
    secondary: AtomicBool,
    stopped: AtomicBool,
}

/// Downloads in progress: the file each one was given, so two downloads with the
/// same name at the same time still get different files.
#[derive(Default)]
struct Downloads {
    pending: Mutex<HashMap<PathBuf, String>>,
}

/// The browser arguments the window gets by default (see wry's WebView2 setup).
const DEFAULT_BROWSER_ARGS: &str =
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection \
     --autoplay-policy=no-user-gesture-required";

/// Numbers the labels of pop-up windows.
static POPUPS: AtomicUsize = AtomicUsize::new(0);

/// Where downloads are saved: POSTBOX_DOWNLOAD_DIR, else the user's Downloads folder.
fn download_dir(app: &AppHandle) -> Option<PathBuf> {
    std::env::var_os("POSTBOX_DOWNLOAD_DIR")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| app.path().download_dir().ok())
}

/// The suggested file name without any folder part, or "download".
fn suggested_name(destination: &Path) -> String {
    let name = destination
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let name: String = name
        .chars()
        .map(|c| {
            if c.is_control() || r#"<>:"/\|?*"#.contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let name = name.trim_matches(|c: char| c == '.' || c.is_whitespace());
    if name.is_empty() {
        "download".to_string()
    } else {
        name.to_string()
    }
}

/// `name`, else `name (1)`, `name (2)` and so on before the extension, as browsers do.
fn unique_path(dir: &Path, name: &str, taken: &HashMap<PathBuf, String>) -> PathBuf {
    let free = |p: &PathBuf| !p.exists() && !taken.contains_key(p);
    let first = dir.join(name);
    if free(&first) {
        return first;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => name.split_at(i),
        _ => (name, ""),
    };
    (1..)
        .map(|n| dir.join(format!("{stem} ({n}){ext}")))
        .find(free)
        .expect("an unused file name")
}

/// Saves every download to the Downloads folder under a new name and confirms it.
fn handle_download(webview: Webview, event: DownloadEvent<'_>) -> bool {
    let app = webview.app_handle();
    let downloads = app.state::<Downloads>();
    match event {
        DownloadEvent::Requested { url, destination } => {
            let Some(dir) = download_dir(app) else {
                return true;
            };
            if let Err(e) = fs::create_dir_all(&dir) {
                show_message(
                    "Download failed",
                    &format!("Could not create {}: {e}", dir.display()),
                );
                return false;
            }
            let mut pending = downloads.pending.lock().unwrap();
            let path = unique_path(&dir, &suggested_name(destination), &pending);
            pending.insert(path.clone(), url.to_string());
            *destination = path;
            true
        }
        DownloadEvent::Finished { url, path, success } => {
            let reserved = {
                let mut pending = downloads.pending.lock().unwrap();
                let key = path
                    .clone()
                    .filter(|p| pending.contains_key(p))
                    .or_else(|| {
                        pending
                            .iter()
                            .find(|(_, u)| **u == url.as_str())
                            .map(|(p, _)| p.clone())
                    });
                key.inspect(|k| {
                    pending.remove(k);
                })
            };
            // A pop-up that only started a download (an export opened with
            // window.open) has nothing to show once the file is saved.
            if webview.label().starts_with("popup-")
                && webview.url().is_ok_and(|u| u.as_str() == "about:blank")
            {
                let _ = webview.window().close();
            }
            match (success, path.or(reserved)) {
                (true, Some(path)) => confirm_saved(path),
                (true, None) => {}
                (false, path) => {
                    let name = path
                        .as_deref()
                        .and_then(Path::file_name)
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_else(|| url.to_string());
                    show_message("Download failed", &format!("{name} was not saved."));
                }
            }
            true
        }
        _ => true,
    }
}

/// Tells the user where a download went and offers to show it in Explorer.
fn confirm_saved(path: PathBuf) {
    thread::spawn(move || {
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let folder = path
            .parent()
            .map(|p| p.display().to_string())
            .unwrap_or_default();
        let text = format!("Saved {name} to {folder}.\n\nShow the file in its folder?");
        if ask("Download complete", &text) {
            show_in_folder(&path);
        }
    });
}

#[cfg(windows)]
fn message_box(title: &str, text: &str, style: u32) -> i32 {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_SETFOREGROUND, MB_TOPMOST};
    let wide = |s: &str| s.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
    let (text, title) = (wide(text), wide(title));
    // SAFETY: both strings are NUL-terminated UTF-16 buffers that outlive the call.
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            text.as_ptr(),
            title.as_ptr(),
            style | MB_SETFOREGROUND | MB_TOPMOST,
        )
    }
}

#[cfg(windows)]
fn ask(title: &str, text: &str) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{IDYES, MB_ICONINFORMATION, MB_YESNO};
    message_box(title, text, MB_YESNO | MB_ICONINFORMATION) == IDYES
}

#[cfg(windows)]
fn show_message(title: &str, text: &str) {
    use windows_sys::Win32::UI::WindowsAndMessaging::MB_ICONWARNING;
    let (title, text) = (title.to_string(), text.to_string());
    thread::spawn(move || message_box(&title, &text, MB_ICONWARNING));
}

#[cfg(windows)]
fn show_in_folder(path: &Path) {
    use std::os::windows::process::CommandExt;
    let _ = Command::new("explorer.exe")
        .raw_arg(format!("/select,\"{}\"", path.display()))
        .spawn();
}

/// Opens a web address in the default browser.
#[cfg(windows)]
fn open_in_browser(url: &Url) {
    let _ = Command::new("rundll32.exe")
        .arg("url.dll,FileProtocolHandler")
        .arg(url.as_str())
        .spawn();
}

#[cfg(not(windows))]
fn ask(_title: &str, text: &str) -> bool {
    eprintln!("{text}");
    false
}

#[cfg(not(windows))]
fn show_message(_title: &str, text: &str) {
    eprintln!("{text}");
}

#[cfg(not(windows))]
fn show_in_folder(_path: &Path) {}

#[cfg(not(windows))]
fn open_in_browser(_url: &Url) {}

/// Whether a URL belongs to the local Postbox server the main window shows.
fn is_app_url(app: &AppHandle, url: &Url) -> bool {
    app.get_webview_window("main")
        .and_then(|w| w.url().ok())
        .is_some_and(|main| main.scheme() == "http" && main.origin() == url.origin())
}

/// Lets pages of the local server save more than one file without the browser's
/// "multiple downloads" prompt, which the window has no UI for. Everything else
/// keeps the WebView2 default.
fn handle_permission(webview: Webview, kind: PermissionKind) -> PermissionResponse {
    let app_page = webview
        .url()
        .is_ok_and(|url| is_app_url(webview.app_handle(), &url));
    if matches!(kind, PermissionKind::AutomaticDownloads) && app_page {
        PermissionResponse::Allow
    } else {
        PermissionResponse::Default
    }
}

/// Decides what happens to window.open and target="_blank" links.
///
/// Pop-ups for the app itself (exports, the OAuth sign-in window, which starts at
/// about:blank and needs window.opener) open as windows of this app, so they keep
/// the session cookie. Other web addresses open in the default browser.
fn new_window_handler(
    app: AppHandle,
) -> impl Fn(Url, NewWindowFeatures) -> NewWindowResponse<tauri::Wry> + Send + 'static {
    move |url, features| {
        if url.as_str() == "about:blank" || is_app_url(&app, &url) {
            match open_popup(&app, features) {
                Ok(window) => NewWindowResponse::Create { window },
                Err(_) => NewWindowResponse::Deny,
            }
        } else {
            if matches!(url.scheme(), "http" | "https") {
                open_in_browser(&url);
            }
            NewWindowResponse::Deny
        }
    }
}

fn open_popup(app: &AppHandle, features: NewWindowFeatures) -> tauri::Result<WebviewWindow> {
    let label = format!("popup-{}", POPUPS.fetch_add(1, Ordering::SeqCst));
    let blank = WebviewUrl::External("about:blank".parse().expect("about:blank is a URL"));
    WebviewWindowBuilder::new(app, label, blank)
        .title("Postbox")
        .window_features(features)
        .on_download(handle_download)
        .on_permission_request(handle_permission)
        .on_new_window(new_window_handler(app.clone()))
        .on_document_title_changed(|window, title| {
            let _ = window.set_title(&title);
        })
        .build()
}

/// The main window. It is built here rather than from tauri.conf.json so it can
/// handle downloads and pop-ups.
fn build_main_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let mut builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("Postbox")
        .inner_size(1280.0, 800.0)
        .min_inner_size(900.0, 600.0)
        .on_download(handle_download)
        .on_permission_request(handle_permission)
        .on_new_window(new_window_handler(app.clone()));
    // The shell always passes its own browser arguments, which hides the standard
    // WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS variable; add it to the defaults instead.
    if let Some(extra) = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS")
        .ok()
        .filter(|v| !v.trim().is_empty())
    {
        builder = builder.additional_browser_args(&format!("{DEFAULT_BROWSER_ARGS} {extra}"));
    }
    builder.build()
}

/// Where postbox.db, backups and logs live: DATA_DIR, else %LOCALAPPDATA%\Postbox.
fn data_dir(app_dir: &Path) -> PathBuf {
    match std::env::var_os("DATA_DIR").filter(|v| !v.is_empty()) {
        Some(dir) => app_dir.join(PathBuf::from(dir)),
        None => {
            let base = std::env::var_os("LOCALAPPDATA")
                .map(PathBuf::from)
                .unwrap_or_else(std::env::temp_dir);
            base.join("Postbox")
        }
    }
}

/// Opens logs\server.log for appending, keeping the previous run as server.log.1.
fn open_server_log(data_dir: &Path) -> std::io::Result<(File, PathBuf)> {
    let logs = data_dir.join("logs");
    fs::create_dir_all(&logs)?;
    let log = logs.join("server.log");
    if log.exists() {
        let _ = fs::rename(&log, logs.join("server.log.1"));
    }
    let file = OpenOptions::new().create(true).append(true).open(&log)?;
    Ok((file, log))
}

/// Replaces the splash text with an error message and the log location.
fn show_error(window: &WebviewWindow, info: &Value) {
    let script = format!(
        "(window.__postboxError || function (i) {{ window.__postboxPending = i; }})({})",
        info
    );
    let _ = window.eval(script);
}

fn error_info(message: &str, log: &Path) -> Value {
    json!({ "message": message, "log": log.display().to_string() })
}

fn spawn_server(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or("The main window is missing")?;
    let resources = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Could not find the app resources: {e}"))?;
    // Node must not receive a \\?\ verbatim path.
    let resources = dunce::simplified(&resources).to_path_buf();
    let app_dir = resources.join("app");
    let node = resources.join("runtime").join("postbox-node.exe");
    let data = data_dir(&app_dir);
    let (stderr_log, log_path) = open_server_log(&data)
        .map_err(|e| format!("Could not open the server log in {}: {e}", data.display()))?;
    let mut stdout_log = stderr_log
        .try_clone()
        .map_err(|e| format!("Could not open the server log: {e}"))?;

    let mut command = Command::new(&node);
    command
        .arg("--use-system-ca")
        .arg(app_dir.join("local.mjs"))
        .current_dir(&app_dir)
        .env("POSTBOX_HOST_PIPE", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::from(stderr_log));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("Could not start {}: {e}", node.display()))?;
    let stdout = child.stdout.take().ok_or("The server has no output pipe")?;

    let server = app.state::<Server>();
    *server.stdin.lock().unwrap() = child.stdin.take();
    *server.child.lock().unwrap() = Some(child);

    let settled = Arc::new(AtomicBool::new(false));

    // Reads the server's stdout until it closes: one protocol line, the rest is log.
    let reader_settled = Arc::clone(&settled);
    let reader_window = window.clone();
    let reader_app = app.clone();
    let reader_log = log_path.clone();
    thread::spawn(move || {
        let mut navigated = false;
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if let Some(payload) = line.strip_prefix(READY_PREFIX) {
                // Only the first ready line points the window at the server. Navigating again
                // would reload the page and rebuild open tabs from browser storage.
                if navigated {
                    let _ = writeln!(stdout_log, "{line}");
                    continue;
                }
                navigated = true;
                let ready: Value = serde_json::from_str(payload).unwrap_or(Value::Null);
                let url = ready["url"].as_str().and_then(|u| Url::parse(u).ok());
                if ready["role"] == "secondary" {
                    reader_app
                        .state::<Server>()
                        .secondary
                        .store(true, Ordering::SeqCst);
                }
                match url {
                    Some(url) => {
                        reader_settled.store(true, Ordering::SeqCst);
                        let _ = reader_window.navigate(url);
                        // A secondary window shares another window's server; that one updates.
                        if ready["role"] != "secondary" {
                            update::schedule(reader_app.clone(), reader_log.clone());
                        }
                    }
                    None => {
                        reader_settled.store(true, Ordering::SeqCst);
                        let info =
                            error_info("The server reported an invalid address.", &reader_log);
                        show_error(&reader_window, &info);
                    }
                }
            } else if let Some(payload) = line.strip_prefix(ERROR_PREFIX) {
                reader_settled.store(true, Ordering::SeqCst);
                let info = serde_json::from_str(payload)
                    .unwrap_or_else(|_| error_info(payload, &reader_log));
                show_error(&reader_window, &info);
            } else {
                let _ = writeln!(stdout_log, "{line}");
            }
        }
        if !reader_settled.swap(true, Ordering::SeqCst) {
            let info = error_info(
                "The Postbox server stopped before it was ready.",
                &reader_log,
            );
            show_error(&reader_window, &info);
        }
    });

    // Gives up waiting after READY_TIMEOUT and says so on the splash.
    thread::spawn(move || {
        thread::sleep(READY_TIMEOUT);
        if !settled.swap(true, Ordering::SeqCst) {
            let info = error_info("The Postbox server did not start in time.", &log_path);
            show_error(&window, &info);
        }
    });
    Ok(())
}

/// Closes the server's stdin (its stop signal), waits briefly, then kills it.
fn stop_server(app: &AppHandle) {
    let server = app.state::<Server>();
    if server.stopped.swap(true, Ordering::SeqCst) {
        return;
    }
    drop(server.stdin.lock().unwrap().take());
    let Some(mut child) = server.child.lock().unwrap().take() else {
        return;
    };
    if server.secondary.load(Ordering::SeqCst) {
        // That copy belongs to another window; this process has already exited.
        let _ = child.try_wait();
        return;
    }
    let deadline = Instant::now() + STOP_TIMEOUT;
    while Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) => thread::sleep(Duration::from_millis(100)),
            Err(_) => break,
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_filter(|label| label == "main")
                .build(),
        )
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Server::default())
        .manage(Downloads::default())
        .setup(|app| {
            let handle = app.handle().clone();
            build_main_window(&handle)?;
            if let Err(message) = spawn_server(&handle) {
                if let Some(window) = handle.get_webview_window("main") {
                    let log = data_dir(Path::new(".")).join("logs").join("server.log");
                    show_error(&window, &error_info(&message, &log));
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to start Postbox Desktop");

    app.run(|handle, event| {
        if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
            stop_server(handle);
        }
    });
}
