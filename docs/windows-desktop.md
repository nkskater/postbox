# Windows desktop app

Postbox Desktop is the installed edition for Windows 10 and 11 (64-bit). It opens Postbox in its own window and
runs the same local server as the [portable edition](../README.md#portable-windows-edition): the server listens on
`127.0.0.1` only, and requests, scripts and collection runs go out from your PC, including through an active VPN.

The installer is per-user. It needs no administrator rights, shows no UAC prompt, and writes nothing outside your
own profile.

## Install

1. Download `Postbox-Desktop-windows-x64-setup.exe` from the
   [latest GitHub release](https://github.com/nkskater/postbox/releases/latest).
2. Run it. The installer is not code-signed yet, so Windows may warn you first:
   - Your browser may say the file is not commonly downloaded. Choose **Keep** (in Edge: **…** → **Keep** →
     **Show more** → **Keep anyway**).
   - SmartScreen may show **Windows protected your PC** with an unknown publisher. Click **More info**, check that
     the app is `Postbox-Desktop-windows-x64-setup.exe`, then click **Run anyway**.
   - On PCs with Smart App Control or an application allow-list, unsigned installers are blocked. Use the portable
     edition there, or ask your administrator.
3. Follow the installer. It installs to `%LOCALAPPDATA%\Postbox Desktop` and adds **Postbox Desktop** to the Start
   menu.

If WebView2 is missing (some older Windows 10 images), the installer downloads and installs it for your user. This
needs an internet connection.

Start **Postbox Desktop** from the Start menu. A window titled **Postbox** shows "Starting Postbox…" for a few seconds
and then the app. Starting it again brings the open window to the front instead of starting a second copy. Closing
the window stops the app; nothing keeps running in the background.

## Where your data lives

| What                     | Location                                    |
| ------------------------ | ------------------------------------------- |
| Database                 | `%LOCALAPPDATA%\Postbox\postbox.db`         |
| Vault key file           | `%LOCALAPPDATA%\Postbox\vault.keys.json`    |
| Daily backups            | `%LOCALAPPDATA%\Postbox\Backups\`           |
| Server log               | `%LOCALAPPDATA%\Postbox\logs\server.log`    |
| Start-up error, if any   | `%LOCALAPPDATA%\Postbox\startup-error.log`  |
| Window profile (WebView) | `%LOCALAPPDATA%\io.github.nkskater.postbox` |
| Program files            | `%LOCALAPPDATA%\Postbox Desktop`            |

Your data is never stored in the program folder, so upgrading or uninstalling does not touch it.

## Downloads and exports

Files you download or export in the app (**Settings → History & data → Download backup**, saved responses, collection,
environment, runner and dataset exports) are saved to your **Downloads** folder (`%USERPROFILE%\Downloads`, or
wherever you moved it). Postbox never overwrites a file there: a second file with the same name is saved as
`name (1).json`, then `name (2).json`, and so on. When a download finishes, a message names the file and offers to
show it in its folder. To save downloads somewhere else, set `POSTBOX_DOWNLOAD_DIR` (see [Settings](#settings)).

Pages the app opens in a new window, such as the OAuth 2.0 sign-in window or the consumer catalog, open in a Postbox
window, so they keep your sign-in. Links to other websites open in your default browser.

## Settings

The desktop app reads settings from **user environment variables**. Open the Start menu, search for **Edit
environment variables for your account**, add or change a variable under _User variables_, then close and restart
Postbox Desktop.

| Variable               | Default                  | Meaning                                                                                    |
| ---------------------- | ------------------------ | ------------------------------------------------------------------------------------------ |
| `DATA_DIR`             | `%LOCALAPPDATA%\Postbox` | Folder for the database, vault key file, backups and logs.                                 |
| `PORT`                 | `47392`                  | Preferred loopback port. If it is taken, Postbox picks another free port for that run.     |
| `BACKUP_KEEP`          | `30`                     | Number of daily backups to keep; `0` turns daily backups off.                              |
| `POSTBOX_PASSWORD`     | _(none)_                 | Requires sign-in with this password. Recommended on a PC that other people also sign into. |
| `POSTBOX_DOWNLOAD_DIR` | Your Downloads folder    | Folder where downloads and exports are saved.                                              |

The server is reachable only from your own PC, but any program running on it (or another user signed into the same
PC) can connect to the loopback port. Set `POSTBOX_PASSWORD`, or create an account in the app, if that matters to
you.

When the preferred port is taken and Postbox moves to another port, the window opens a different address, so UI
preferences and your sign-in from earlier sessions are not available for that session. Set `PORT` to a free port to
avoid this.

## Upgrade

Download the newer installer and run it. If Postbox Desktop is running, the installer asks to close it first. Your
data is kept.

## Uninstall

Open **Settings → Apps → Installed apps**, find **Postbox Desktop** and choose **Uninstall** (or run
`uninstall.exe` in `%LOCALAPPDATA%\Postbox Desktop`). The uninstaller removes the program files, shortcuts and the
uninstall entry.

Your data stays in `%LOCALAPPDATA%\Postbox` unless you tick **Delete the application data** in the uninstaller. That
option deletes the database, vault key file, backups, logs and the window profile, and cannot be undone. Download a
backup first if you might need the data again.

## Silent install

The installer accepts these switches:

| Switch      | Effect                                                                                        |
| ----------- | --------------------------------------------------------------------------------------------- |
| `/S`        | Silent install, no windows.                                                                   |
| `/P`        | Passive install: shows progress but asks nothing.                                             |
| `/NS`       | Does not create Start menu or desktop shortcuts.                                              |
| `/D=<path>` | Installs to another folder. Must be the last switch and must not be quoted, even with spaces. |

```bat
Postbox-Desktop-windows-x64-setup.exe /S
Postbox-Desktop-windows-x64-setup.exe /P /D=%LOCALAPPDATA%\Programs\Postbox Desktop
```

`uninstall.exe /S` removes the app silently and keeps your data.

## Moving existing data

**From the portable edition.** Close both apps. Copy the contents of the portable edition's `Data` folder
(`postbox.db`, `vault.keys.json` and `Backups\`) into `%LOCALAPPDATA%\Postbox`, replacing what is there. Or keep the
data where it is and set the user variable `DATA_DIR` to the portable `Data` folder. Only run one of the two editions
at a time against the same folder.

**From Docker.** Stop the container, then copy `/data/postbox.db` and `/data/vault.keys.json` out of its volume into
`%LOCALAPPDATA%\Postbox`. This is a full copy, including accounts, history and secrets. To move workspace data only,
use **Settings → History & data → Download backup** in the Docker install and **Restore from file…** in the desktop
app (see [History, backups and database maintenance](backup-and-data.md)).

Without `vault.keys.json`, secrets stored in the vault cannot be decrypted; copy it together with the database.

## Troubleshooting

| Symptom                                     | What to check                                                                                                                                |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| The window shows "Postbox could not start"  | The message names a log file. Open `startup-error.log` and `logs\server.log` in the data folder; `logs\server.log.1` holds the previous run. |
| The window stays on "Starting Postbox…"     | After 90 seconds it shows an error. Check `logs\server.log`; antivirus scanning the first start can be slow.                                 |
| HTTPS requests fail with certificate errors | Postbox uses the Windows certificate store. Make sure your company's root certificate is installed for your user or the PC.                  |
| The installer is blocked                    | See the SmartScreen notes under [Install](#install), or use the portable edition.                                                            |

## Building the installer

The installer is built on Windows by the CI job **Build and smoke test Windows desktop installer** and attached to
tagged releases. On a Windows machine with Node.js 22 and the Rust toolchain:

```bat
npm ci
npm ci --prefix desktop
npm run build:desktop
```

This writes `dist\Postbox-Desktop-windows-x64-setup.exe`. `npm run build:desktop -- --stage-only` stages
`desktop\payload\` without building the installer and works on any operating system.
