# User Settings Additions

Luker preserves SillyTavern's **User Settings** drawer unchanged: familiar settings remain in their original locations. Beyond them, Luker adds its own entries: additional buttons in the top row, a complete backup and migration toolkit under **Account**, and a set of switches found only in Luker.

The drawer is opened from the **User Settings** icon in the top bar. This page covers the additions; the rest of the drawer behaves as SillyTavern documents it.

## Logs, debug export and the request inspector

Three buttons in the top row of the drawer:

- **Logs** — opens the log viewer. Select a source: **Server** (shown when you are allowed to read server logs) or **Frontend**. You can filter by time range and maximum entries, search, copy, clear, and leave auto-refresh enabled. Server logs are held in memory and are cleared when the server restarts.
- **Export Debug Logs** — downloads one bundled report for troubleshooting: `luker-debug-<timestamp>.json`, containing frontend logs, performance marks, device and viewport details, server logs, the [Request Inspector](/improvements/request-inspector) buffer, and runtime information. In the Android app, the button invokes the app's native diagnostics export instead.
- **Inspector** — opens the [Request Inspector](/improvements/request-inspector): the lifecycle and token usage of every generation request, including image generation and embedding / rerank calls.

The Logs viewer and the frontend log buffer are described in more detail under [Logging](/features/logging).

## Immersive mode

**Enter immersive mode** hides the interface chrome and goes fullscreen where the browser allows it. It is intended for reading long replies without interface distractions. Exit from the same button, from the on-screen exit control, with `Esc`, or — in the Android app — with the back gesture. Luker remembers whether you were in immersive mode and restores it.

One related switch is located under **UI Theme**:

- **Keep top bar in immersive mode** — keep the top bar visible while immersive mode is on, instead of hiding it. Useful when quick access to the menus is needed while reading.

## Backup, migration and storage

The **Account** button in the top row opens a popup whose entries include:

- **Backup and Restore** — a catalog-level backup manager. Choose which **Data Categories** to include: **Settings**, **API Keys / Secrets**, **Characters / Avatars**, **Chats / Groups**, **Lorebooks**, **Presets / UI Layout**, **Assets / Files**, **User Extensions**, **Global Extensions (Admin)**, and **Vector Indexes**. **Select All**, **Use Defaults** and **Clear** set the entire selection at once, and the selection applies to every action below it.

  Then either **Download Backup ZIP**, or restore one with **Select ZIP** and **Restore Backup** in one of two modes: **Incremental Update** writes the files from the backup and keeps everything else, while **Overwrite Update** clears the selected categories first and then restores. If the ZIP comes from a server running a different storage engine, Luker detects the cross-mode restore and requests a temporary database connection through which it stages the restore.

- **LAN Migration** — a one-time transfer to a new device: **Create Migration Link** on the old device, then paste it into **Migrate from Link** on the new one. Migration links expire quickly and can be used only once. For two devices used side by side on an ongoing basis, [LAN Sync](/improvements/lan-sync) is the preferable option: it is two-way and incremental, and transfers only what changed.

- **Storage Inspector** and **Browser Storage** — two views of where your data resides. The [Storage Inspector](/features/storage-inspector) breaks down your server-side data directory by category with a quota bar, size-only entries for sensitive blobs and no delete actions; **Browser Storage** inspects this browser's `localStorage`, `sessionStorage`, IndexedDB and Cache Storage, and can delete individual keys, stores, databases and caches.

## Mobile: keeping generation alive

Two settings matter when you use Luker on a phone.

- **Background keep-alive on mobile** (under **UI Theme**) — maintains AI requests when the app or the browser is in the background. On Android it is a single switch that asks the native layer to keep requests alive. In a mobile browser, enabling it opens a popup where you choose:

  - **Picture-in-Picture** — a small floating window stays on screen. It does not interrupt music.
  - **Audio** — a silent media session that engages only while a message is generating and disengages shortly after it finishes; other music or video apps are paused while it runs.

  Both choices are remembered. On desktop the row is hidden entirely, because the issue does not arise there.

- **Generation Complete Notification** and **Notification Detail** (under **Miscellaneous**) — display a system notification when generation finishes while Luker is in the background. **Notification Detail** chooses between **Status only** and **Include message content**, so a notification can convey the reply content without switching back to the app. Notifications are suppressed when the page is focused.

## Chat rendering and leaving the page

Two smaller additions under **Chat/Message Handling**:

- **Lazy-load Message Media** — enabled by default. Chat images and videos load only as they approach the viewport, which keeps the rendering cost of long chats with extensive media low. Extensions that need a specific element loaded immediately can opt out per element.
- **Leave-page confirmation** — warns before you close or reload the page. **Only when risky** (the default) warns when a generation is running, a message edit is open, or you have unsent text in the input box; **Never** and **Always** override that judgement.

## Diagnostics switches

When you need to provide evidence rather than just a description:

- **Frontend debug logs** — mirrors all frontend console output to the browser console for troubleshooting. Frontend logs are captured in the in-memory buffer regardless of this switch; this switch controls how much reaches the console.
- **Android debug recording** — Android app only. Records extra diagnostics (console output, heap samples, render markers, web view crashes) into the native debug trail used by crash reports. It takes effect after the next app restart.
- **Enable JS Self-Profiling (Experimental)** and **Download Performance Profile** — start the browser's JS Self-Profiling API as early as possible and continue sampling until you disable it. The download button saves a profile snapshot; if the switch remains enabled, profiling automatically restarts after the download. This pair of features is limited to Chrome and Edge — Safari and Firefox do not support the API.

::: tip Related pages
[Logging](/features/logging) · [Request Inspector](/improvements/request-inspector) · [Storage Inspector](/features/storage-inspector) · [LAN Sync](/improvements/lan-sync) · [Other Features](/features/other-features)
:::
