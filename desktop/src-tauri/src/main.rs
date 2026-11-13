// Postbox Desktop: a native window around the bundled local server.
//
// The shell starts `runtime\postbox-node.exe app\local.mjs` in host mode
// (POSTBOX_HOST_PIPE=1), waits for its single POSTBOX_READY line and points the
// window at the loopback URL it reports. Closing stdin tells the server to stop,
// so the server also stops when this process dies. No commands are exposed to
// pages: everything the window shows is the regular web UI.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewWindow};

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
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if let Some(payload) = line.strip_prefix(READY_PREFIX) {
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
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(Server::default())
        .setup(|app| {
            let handle = app.handle().clone();
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
