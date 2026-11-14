// In-app updates from GitHub Releases.
//
// Once per run, 30 seconds after the window has loaded the app and at most once a
// day, the shell reads latest.json from the latest GitHub release. If a newer
// version exists it asks the user. On Yes it downloads the installer, verifies its
// update signature, stops the server and runs the per-user installer in update
// mode, which restarts the app. Everything happens in the shell: pages cannot
// start, steer or see an update.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, SystemTime};

use tauri::{AppHandle, Manager, Url};
use tauri_plugin_updater::UpdaterExt;

const CHECK_DELAY: Duration = Duration::from_secs(30);
const CHECK_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);
const STAMP_FILE: &str = "last-update-check";

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

/// Overrides for the CI smoke test. They exist only in debug builds and in builds
/// with the `update-test` feature; release builds ignore these variables.
struct TestHooks {
    endpoint: Option<Url>,
    auto_accept: bool,
    delay: Option<Duration>,
}

fn test_hooks() -> TestHooks {
    if cfg!(any(debug_assertions, feature = "update-test")) {
        TestHooks {
            endpoint: env("POSTBOX_UPDATE_ENDPOINT").and_then(|v| Url::parse(&v).ok()),
            auto_accept: env("POSTBOX_UPDATE_AUTO").as_deref() == Some("1"),
            delay: env("POSTBOX_UPDATE_DELAY_SECS")
                .and_then(|v| v.parse().ok())
                .map(Duration::from_secs),
        }
    } else {
        TestHooks {
            endpoint: None,
            auto_accept: false,
            delay: None,
        }
    }
}

/// Appends a line to logs\server.log; update problems are logged, never shown.
fn log(path: &Path, message: &str) {
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "[updater] {message}");
    }
}

/// Whether a check is due: none in the last 24 hours. Records this check.
fn due(app: &AppHandle) -> bool {
    let Ok(dir) = app.path().app_config_dir() else {
        return true;
    };
    let stamp = dir.join(STAMP_FILE);
    let recent = fs::metadata(&stamp)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| SystemTime::now().duration_since(t).ok())
        .is_some_and(|age| age < CHECK_INTERVAL);
    if recent {
        return false;
    }
    let _ = fs::create_dir_all(&dir);
    let _ = fs::write(&stamp, b"");
    true
}

/// Starts the background check. Called once, when the window first shows the app.
pub fn schedule(app: AppHandle, log_path: PathBuf) {
    if env("POSTBOX_NO_UPDATE_CHECK").as_deref() == Some("1") {
        log(
            &log_path,
            "update check turned off (POSTBOX_NO_UPDATE_CHECK=1)",
        );
        return;
    }
    let hooks = test_hooks();
    thread::spawn(move || {
        thread::sleep(hooks.delay.unwrap_or(CHECK_DELAY));
        // The test endpoint is checked on every start; real checks once a day.
        if hooks.endpoint.is_none() && !due(&app) {
            return;
        }
        if let Err(e) = tauri::async_runtime::block_on(check(&app, &hooks, &log_path)) {
            log(&log_path, &format!("update check failed: {e}"));
        }
    });
}

async fn check(app: &AppHandle, hooks: &TestHooks, log_path: &Path) -> Result<(), String> {
    let mut builder = app.updater_builder();
    if let Some(endpoint) = &hooks.endpoint {
        builder = builder
            .endpoints(vec![endpoint.clone()])
            .map_err(|e| e.to_string())?;
    }
    // The installer replaces files the server is using: stop it first, the same
    // way as when the window closes.
    let stopping = app.clone();
    let updater = builder
        .on_before_exit(move || crate::stop_server(&stopping))
        .build()
        .map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        log(log_path, "Postbox is up to date");
        return Ok(());
    };
    log(
        log_path,
        &format!(
            "version {} is available (installed: {})",
            update.version, update.current_version
        ),
    );
    let question = format!(
        "Postbox {} is available. You have {}.\n\n\
         What's new: https://github.com/nkskater/postbox/releases/tag/v{}\n\n\
         Download and install it now? Postbox closes and starts again when the update is installed.",
        update.version, update.current_version, update.version
    );
    if !hooks.auto_accept && !crate::ask("Postbox update", &question) {
        log(log_path, "update postponed by the user");
        return Ok(());
    }
    // download() verifies the update signature against the public key in
    // tauri.conf.json and fails on a mismatch.
    let bytes = update
        .download(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    log(log_path, &format!("installing version {}", update.version));
    // On Windows this starts the installer in update mode and exits the app.
    update.install(bytes).map_err(|e| e.to_string())
}
