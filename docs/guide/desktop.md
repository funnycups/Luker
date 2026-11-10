---
description: Luker provides a desktop app that runs the complete Luker server and interface as a standalone application on macOS, Windows, and Linux. This guide covers downloading, installing, the first-launch security prompts, where the app stores its data, and uninstalling.
---

# Desktop App

Luker provides a desktop app that runs the complete Luker server and interface as a standalone application on macOS, Windows, and Linux. Opening it displays the full Luker interface — there is no separate address to open in a browser.

## Download

Download the latest release from the GitHub Releases page:

👉 [https://github.com/funnycups/Luker/releases/latest](https://github.com/funnycups/Luker/releases/latest)

Each release ships an installer and a no-install form for macOS, Windows, and Linux. The file name carries the version, the platform, and the architecture, for example `Luker-2.8.0-mac-arm64.dmg`.

| File name | What it is |
| --- | --- |
| `Luker-<version>-mac-<arch>.dmg` | macOS disk image; drag the app into Applications |
| `Luker-<version>-mac-<arch>.zip` | macOS archive of the same app, unpack it anywhere |
| `Luker-<version>-win-<arch>.exe` | Windows installer; installs the app and adds shortcuts |
| `Luker-<version>-win-<arch>.zip` | Windows portable archive that runs without installing |
| `Luker-<version>-linux-x86_64.AppImage` and `Luker-<version>-linux-arm64.AppImage` | Linux AppImage; make it executable with `chmod +x` and run it, on any distribution |
| `Luker-<version>-linux-amd64.deb` and `Luker-<version>-linux-arm64.deb` | Debian and Ubuntu package |
| `Luker-<version>-linux-x86_64.rpm` and `Luker-<version>-linux-aarch64.rpm` | Fedora and openSUSE package |

`<arch>` is `arm64` on Apple Silicon and on Windows on ARM, and `x64` on Intel Macs and on Intel or AMD Windows. Pick the file that matches your machine.

On Linux the architecture spelling depends on the format: `.AppImage` uses `x86_64` and `arm64`, `.deb` uses `amd64` and `arm64`, and `.rpm` uses `x86_64` and `aarch64`.

## Install

Either form works; you do not need both.

### macOS

- **`.dmg`** — open it and drag **Luker** into **Applications**.
- **`.zip`** — unpack it and move `Luker.app` into **Applications**.

### Windows

- **`.exe`** — run it and follow the installer.
- **`.zip`** — unpack it and run `Luker.exe` from the unpacked folder.

Antivirus software sometimes flags the `.exe` because it is not code-signed. If that happens, allow the file and run it again.

### Linux

- **`.AppImage`** — make it executable with `chmod +x`, then run it.
- **`.deb`** — install it with your package manager.
- **`.rpm`** — install it with your package manager.

On Ubuntu 24.04 and later, the AppImage may need `--no-sandbox` in its launch arguments before it starts. The `.deb` and `.rpm` packages do not need this.

## First Launch

The app is not signed with a paid code-signing certificate, so macOS and Windows each show a security warning the first time it opens. The warning is expected, and the app runs normally once you allow it.

### macOS

macOS blocks the first launch with a message that it cannot verify the app. Open **System Settings** → **Privacy & Security**, find the notice about Luker, and click **Open Anyway**. Confirm in the dialog that follows.

### Windows

SmartScreen shows a **Windows protected your PC** window with an unknown publisher. Click **More info**, then **Run anyway**.

## Data Directory

The app keeps everything it owns under a single directory:

| Platform | Location |
| --- | --- |
| macOS | `~/Library/Application Support/Luker` |
| Windows | `%APPDATA%\Luker` |
| Linux | `~/.config/Luker` |

Inside it:

- `config.yaml` — the server configuration file
- `data/` — the chat, preset, and world storage root
- `backups/` — chat backups
- `plugins/` — server plugins
- `extensions/third-party/` — third-party extensions

### Changing the Data Directory

Open **User Settings** → **Account** → **Storage**, find **Data directory**, and click **Change**. Choose an empty folder or an existing Luker data folder. The folder is used exclusively by Luker and needs enough free space for the current data.

The app moves chats, backups, plugins, extensions, and the server configuration to the chosen folder and restarts. After the move completes, the app removes the old data. If the folder is unavailable at startup, the app offers to retry, choose another folder, or quit, and does not fall back to the default directory.

Browser sign-in state and cache are not moved. If user accounts are enabled, sign in again after the move.

## Uninstall

Uninstalling removes the app itself and leaves the data directory untouched, for both the installer and the no-install form. The app keeps a record of the chosen data location, so a later install uses the same directory. Chats, presets, and settings stay in place.

To remove everything as well, delete the data directory listed above after uninstalling.

## Closing the Window

On Windows and macOS, closing the window keeps the app running: the server and any reply still being written carry on in the background, and opening the window again returns to the same page. Quit the app when you are done.

On Windows, closing the window moves the app to the notification area. Its menu opens the window, opens the data directory, and quits the app. Windows 11 files new notification-area icons into its overflow panel, so the icon may be there after the first close.

On macOS, closing the window leaves the app in the Dock. Clicking the Dock icon opens the window again, **Luker** → **Open data directory** opens the data directory, and ⌘Q quits the app.

On Linux, there is no tray, so closing the window quits the app and the server stops with it.

## Storage Backend

The desktop app supports the `fs`, `mysql`, and `postgres` storage backends. The `sqlite` backend is not supported; use `fs` for local storage.

## Running from Source

`npm run start:electron` from a checkout launches the same app against the checkout's code. It uses the same data directory as the installed app, not the checkout's `./data`, so configuration, chats, and presets written by either run are visible to the other.

## Updates

When a new version is available, the app shows an update prompt in the interface. **Download Update** fetches the installer for the current platform and hands it to the system installer.

On Linux, the AppImage is replaced in place, and the app asks you to restart once the replacement is done. A `.deb` or `.rpm` update is handed to the system installer.

## Related Pages

- [Getting Started](/guide/getting-started) — install Luker and configure the first API connection
- [Configuration](/guide/configuration) — configuration reference
- [Storage Backend](/guide/configuration#storage-backend) — the backends the server supports
