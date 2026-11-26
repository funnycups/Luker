# User Settings Additions

Luker preserves SillyTavern's **User Settings** drawer unchanged: familiar settings remain in their original locations. Beyond them, Luker adds its own entries: additional buttons in the top row, a complete backup and migration toolkit under **Account**, and a set of switches found only in Luker. At the top of the drawer, Luker shows its version and the matching SillyTavern compatibility version.

The drawer is opened from the **User Settings** icon in the top bar. This page covers the additions; the rest of the drawer behaves as SillyTavern documents it.

## Logs, request inspector and diagnostics

The top row adds three troubleshooting controls:

- **Logs** — opens the log viewer. Select a source: **Server** (shown when you are allowed to read server logs) or **Frontend**. You can filter by time range and maximum entries, search, copy, clear, refresh manually, and leave auto-refresh enabled. Server logs are held in memory and are cleared when the server restarts.
- **Inspector** — opens the [Request Inspector](/improvements/request-inspector): the lifecycle and token usage of every generation request, including image generation and embedding / rerank calls.
- **Diagnostics** — opens a menu of troubleshooting actions:
  - **Export Debug Logs** — downloads one bundled report for troubleshooting: `luker-debug-<timestamp>.json`, containing frontend logs, performance marks, device and viewport details, server logs, the [Request Inspector](/improvements/request-inspector) buffer, and runtime information. In the Android app, this entry invokes the app's native diagnostics export instead.
  - **Download Performance Profile** — saves a profile snapshot from the browser's JS Self-Profiling API. The entry is shown in browsers only; Chrome and Edge currently implement the API.
  - **Enable JS Self-Profiling (Experimental)** — shown in browsers only. Starts the browser's JS Self-Profiling API as early as possible and keeps sampling until you turn it off. While the switch stays on, sampling continues after a profile download.
  - **Frontend debug logs** — lets all console levels reach the browser console. Console output is written to the in-memory buffer regardless of this switch.
  - **Android debug recording** — Android app only. Records extra diagnostics (console output, heap samples, render markers, web view crashes) into the native debug trail used by crash reports. It takes effect after the next app restart.
  - **Capture Memory Snapshot** and **Start Performance Recording** — shown to administrators in apps that support capture. The first saves a heap snapshot; the second starts a performance trace and turns into **Stop Performance Recording**, which saves the trace when stopped.

The Logs viewer and the frontend log buffer are described in more detail under [Logging](/features/logging).

## Compact composer themes

Themes with a compact three-column composer can opt into keeping long drafts expanded when the textarea loses focus. Set `--composer-compact-padding-x` to the compact textarea's padding on each side in pixels. Luker adds `data-composer-draft-wrap` to the send form when the draft has a newline or is wider than the compact text column. Keep the middle grid track the same width in both layouts so the threshold stays stable.

```css
#nonQRFormItems {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    --composer-compact-padding-x: 4px;
}
#leftSendForm { grid-area: 1 / 1; }
#rightSendForm { grid-area: 1 / 3; }
#nonQRFormItems > #send_textarea {
    grid-area: 1 / 2;
    min-width: 0;
    width: 100%;
    padding-inline: var(--composer-compact-padding-x);
}
#send_form[data-composer-draft-wrap] #send_textarea { grid-area: 1 / 1 / 2 / -1; }
#send_form[data-composer-draft-wrap] :is(#leftSendForm, #rightSendForm) { grid-row: 2; }
```

## Immersive mode

**Enter immersive mode** hides the interface chrome and goes fullscreen where the browser allows it. It is intended for reading long replies without interface distractions. Exit from the same button, from the on-screen exit control, with `Esc`, or — in the Android app — with the back gesture. Luker remembers whether you were in immersive mode and restores it.

One related switch is located under **UI Theme**:

- **Keep top bar in immersive mode** — keep the top bar visible while immersive mode is on, instead of hiding it. Useful when quick access to the menus is needed while reading.

## Backup, migration and storage

The **Account** button in the top row opens a popup with the following Luker additions:

- **Backup & Restore** — a catalog-level backup manager. Choose which **Data Categories** to include: **Settings**, **API Keys / Secrets**, **Characters / Avatars**, **Chats / Groups**, **Lorebooks**, **Presets / UI Layout**, **Assets / Files**, **User Extensions**, **Global Extensions (Admin)**, and **Vector Indexes**. **Select All**, **Use Defaults** and **Clear** set the entire selection at once, and the selection applies to ZIP download, ZIP restore, and LAN migration.

  Then either **Download Backup ZIP**, or restore one with **Select ZIP** and **Restore Backup** in one of two modes: **Incremental Update** writes the files from the backup and keeps everything else, while **Overwrite Update** clears the selected categories first and then restores. If the ZIP comes from a server running a different storage engine, Luker detects the cross-mode restore and requests a temporary database connection through which it stages the restore.

- **LAN Migration** — a one-time transfer to a new device: **Create Migration Link** on the old device, then paste it into **Migrate from Link** on the new one. Migration links expire quickly and can be used only once. The selected restore mode also applies when importing from a migration link. For ongoing use across devices, use [Sync](/improvements/sync) through [LAN pairing](/improvements/lan-sync) or [encrypted S3 storage](/improvements/s3-sync).

- **Sync** — open **User Settings → Account → Backup & Restore → Sync → Open Sync**. The [Sync overview](/improvements/sync) covers automatic synchronization, categories, pending decisions, chat branches and Undo; the LAN and S3 guides above cover setup.

- **Storage Inspector** and **Browser Storage** — two views of where your data resides. The [Storage Inspector](/features/storage-inspector) breaks down your server-side data directory by category with a quota bar, size-only entries for sensitive blobs and no delete actions; **Browser Storage** inspects this browser's `localStorage`, `sessionStorage`, IndexedDB and Cache Storage, and can delete individual keys, stores, databases and caches.

- **Data directory** — desktop app only. Shows where Luker keeps chats, backups, plugins and extensions. **Change** moves them to another folder and restarts Luker, or switches to an existing Luker data folder; the folder must be writable and have enough free space. If it is unavailable at startup, Luker offers retry, another folder, or quit. See [Changing the Data Directory](/guide/desktop#changing-the-data-directory).

## Background generation and notifications

Two settings matter when generation leaves the foreground.

- **Background keep-alive on mobile** (under **UI Theme**) — maintains AI requests when the app or the browser is in the background. On Android and HarmonyOS it is a single switch that asks the native layer to keep requests alive. In a mobile browser, enabling it opens a popup where you choose:

  - **Picture-in-Picture** — a small floating window stays on screen and shows the character, the generation status and the reply as it streams. It does not interrupt music. Tapping the window to return to Luker closes it; while a generation is running, **Restore Picture-in-Picture** reopens it. iPhone Home Screen web apps do not offer this option.
  - **Audio** — a silent media session that engages only while an AI request or background task is running and disengages shortly after it finishes; other music or video apps are paused while it runs.

  Both choices are remembered. On desktop the row is hidden entirely, because the issue does not arise there.

- **Generation Complete Notification** and **Notification Detail** (under **Miscellaneous**) — display system notifications while Luker is in the background. A progress notification appears when generation starts, then gives way to the result; a failed generation produces a failure notification as well. **Notification Detail** chooses between **Status only** and **Include message content**, so a notification can convey the reply content without switching back to the app. Notifications are suppressed when the page is focused.

## External links

- **Open external links in the system browser** (under **UI Theme**) — shown in the desktop, Android and HarmonyOS apps, and enabled by default. When turned off, ordinary third-party links open inside the Luker window. Links that request a separate window still open as an in-app floating window, so authorization flows keep working. In a browser the row is hidden; the iOS app always opens external links in the system browser.

## Chat rendering

- **Lazy-load Message Media** — enabled by default. Chat images and videos load only as they approach the viewport, which keeps the rendering cost of long chats with extensive media low. Extensions that need a specific element loaded immediately can opt out per element.
- **Arrow key swipes** — enabled by default, shown on desktop only. When turned off, the left and right arrow keys no longer swipe the last reply.

::: tip Related pages
[Logging](/features/logging) · [Request Inspector](/improvements/request-inspector) · [Storage Inspector](/features/storage-inspector) · [Sync](/improvements/sync) · [LAN Sync](/improvements/lan-sync) · [S3 Sync](/improvements/s3-sync) · [Other Features](/features/other-features)
:::
