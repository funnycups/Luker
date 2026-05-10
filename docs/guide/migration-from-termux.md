# Migrating from Termux SillyTavern to the Luker APK

If you've been running original SillyTavern in Termux and want to switch to the Luker Android APK, this guide walks you through bringing your data along. Luker is fully data-compatible with SillyTavern, and the APK shows an import wizard on first launch — you usually don't need to touch the `Android/data` private directory.

After migration, your character cards, chat logs, lorebooks, presets, personas, and extension settings will load normally.

::: tip Scope
This guide covers **Termux SillyTavern → Luker APK**. For PC / Linux / Docker SillyTavern → Luker server, or Termux ↔ Termux migrations, see [Migrating from SillyTavern](/guide/migration).
:::

## Recommended flow: the first-launch import wizard

This flow doesn't require a file manager that can enter `Android/data/`.

### 1. Pack your data into a ZIP inside Termux

If `zip` isn't installed yet:

```bash
pkg install zip
```

Grant Termux storage access (only needed once) so it can write to shared storage:

```bash
termux-setup-storage
```

ZIP your SillyTavern user data and drop it into shared `Download/` (where the system file picker can see it):

```bash
cd ~/SillyTavern/data
zip -r ~/storage/shared/Download/sillytavern-data.zip default-user
```

If you have multi-user mode enabled, include every user subdirectory:

```bash
cd ~/SillyTavern/data
zip -r ~/storage/shared/Download/sillytavern-data.zip *
```

If you want global third-party extensions to come along too, pack them separately:

```bash
cd ~/SillyTavern/public/scripts/extensions
zip -r ~/storage/shared/Download/sillytavern-extensions.zip third-party
```

If you'd previously customized your server `config.yaml` (port, proxy, etc.), copy it to the same location so you can pick it up alongside the data ZIP:

```bash
cp ~/SillyTavern/config.yaml ~/storage/shared/Download/sillytavern-config.yaml
```

::: tip ZIP path prefixes are forgiving
Luker's importer auto-recognizes subdirectories like `characters/`, `chats/`, `worlds/` regardless of whether they sit under `data/default-user/...`, `default-user/...`, or directly at the ZIP root — they all land in the right place.
:::

### 2. Install the Luker APK and trigger the first-launch wizard

Download the latest APK from [GitHub Releases](https://github.com/funnycups/Luker/releases/latest).

The **first time you open** Luker, a **"Welcome to Luker!"** dialog appears. The top of the dialog has a Language selector. The middle has a **"Migrate from SillyTavern"** block with three side-by-side buttons:

| Button | Purpose | What to pick |
| --- | --- | --- |
| **Import Data ZIP** | Primary migration entry — user data (characters / chats / lorebooks / presets / secrets / etc.) | The `sillytavern-data.zip` from step 1 |
| **Import config.yaml** | Carry over the original SillyTavern server config | `sillytavern-config.yaml` (optional) |
| **Import Global Extensions ZIP** | Global third-party extensions | `sillytavern-extensions.zip` (optional) |

Tap each button you need, choose the file in the system picker, and wait for each toast to confirm completion. The three buttons are independent and can be triggered in any order.

### 3. Finish the wizard

The wizard then asks for a username (used as your default persona name). Once that's set, Luker enters the main UI — your character list, chats, lorebooks, presets, and API keys should already be in place.

## What if I missed the first-launch wizard?

If you closed the wizard, or have already used Luker for a while and now want to import, run the same import from the user-management panel:

1. Open **User Settings** → click **Account**
2. Find the **Backup and Restore** button on your user card
3. In the panel, click **Import Data ZIP** and pick the ZIP
4. In the confirmation dialog, choose **Incremental Update** (overlay-by-path, doesn't wipe other files) or **Overwrite Update** (clear the selected categories first, then restore)

The same panel also exposes LAN Migration, Download Backup ZIP, and per-category restore — see below.

## LAN Migration (when both ends are Luker)

If your source side is already running Luker (another Luker APK, or Luker server inside Termux) and the target is the Luker APK, you can skip ZIPs entirely with LAN Migration:

1. On the source, open the **Backup and Restore** panel and click **Create Migration Link** to generate a one-shot link
2. On the target, paste the link into **Migrate from Link** and click import
3. The two devices transfer + restore over the local network

The link is single-use and expires quickly. Original SillyTavern lacks this UI, so a SillyTavern → APK first migration has to go through the ZIP flow above. After that, LAN Migration is available for any future device moves.

## Fallback: copy by hand into the app-specific data directory

You only need this path when:

- The ZIP flow fails (import errors, the file picker can't see the ZIP, etc.)
- You need to preserve files Luker's importer doesn't recognize
- You want to surgically replace a specific file rather than do a bulk import

Luker APK stores its data at `/storage/emulated/0/Android/data/com.luker.app/files/luker-data/`. The internal layout matches SillyTavern's `data/` directory. Android 11+ restricts access to this path, so most stock file managers can't enter it without authorization or a different tool.

### 1. Export your data to shared storage from Termux

```bash
mkdir -p ~/storage/shared/Luker-migration
cp -r ~/SillyTavern/data ~/storage/shared/Luker-migration/
```

Bring third-party extensions along too if you have them:

```bash
cp -r ~/SillyTavern/public/scripts/extensions/third-party \
      ~/storage/shared/Luker-migration/
```

### 2. Launch Luker once so the data directory is created

Open the APK once to let `luker-data/` get generated. Without this, the destination directory you'll be writing to doesn't exist yet.

### 3. Force-stop Luker

System Settings → Apps → Luker → **Force stop**. You don't want Luker holding the directory open while you copy files in.

### 4. Move data into the Luker data directory

Open a file manager and navigate to:

```
/storage/emulated/0/Android/data/com.luker.app/files/luker-data/
```

Copy **the contents of** the `data/` directory from step 1 — i.e. the files and subdirectories that live *inside* `data/`, not the `data/` directory itself.

After the move, `luker-data/` should contain:

- `default-user/` (or other username subdirectories in multi-user mode, one per account)
- Inside each user: `characters/`, `chats/`, `worlds/`, `OpenAI Settings/`, `User Settings/`, `secrets.json`, etc.

If you have third-party extensions, place their contents under:

```
/storage/emulated/0/Android/data/com.luker.app/files/luker-data/extensions/third-party/
```

::: warning Don't overwrite `_runtime-persist`
Luker APK maintains a `_runtime-persist/` directory inside `luker-data/` for runtime persistence artifacts. **Don't overwrite or delete it** — original SillyTavern doesn't produce this directory, so it won't appear in your export.
:::

### 5. Restart Luker and verify

Reopen the APK. After loading, your characters, chats, lorebooks, presets, and API connections should all come back.

### File manager can't access Android/data?

Android 11+ restricts `Android/data/`, and different OEMs handle it differently:

- **Xiaomi / Redmi (MIUI / HyperOS)**: bundled "File Manager" can enter `Android/data`; the first access prompts for permission
- **OPPO / OnePlus / Realme (ColorOS), vivo (OriginOS / FuntouchOS), Huawei / Honor**: their own file managers usually allow access; some require granting "File management" under Privacy / Special permissions
- **Samsung (One UI)**: bundled "My Files" works; some versions require long-pressing the directory to authorize
- **Stock Android / Pixel**: Google's Files app blocks access by default; use a third-party tool

If your file manager can't enter `Android/data/com.luker.app/`, options:

- **Third-party file manager**: MT Manager, MiXplorer, Solid Explorer, Material Files (open source) — all handle `Android/data` reasonably
- **PC over USB**: connect via USB in MTP mode and drag files from your computer
- **ADB push**: `adb push ./data/. /sdcard/Android/data/com.luker.app/files/luker-data/` — fastest and least error-prone for large transfers

## Path reference

| What | Termux source | Luker APK target |
| --- | --- | --- |
| Data root | `~/SillyTavern/data/` | `…/com.luker.app/files/luker-data/` |
| Characters | `data/<user>/characters/` | `luker-data/<user>/characters/` |
| Chats | `data/<user>/chats/` | `luker-data/<user>/chats/` |
| Lorebooks | `data/<user>/worlds/` | `luker-data/<user>/worlds/` |
| Presets | `data/<user>/OpenAI Settings/` etc. | Same subdirectories |
| API keys | `data/<user>/secrets.json` | Same name |
| Third-party extensions | `public/scripts/extensions/third-party/` | `luker-data/extensions/third-party/` |
| Server plugins | `plugins/` | `luker-data/plugins/` |

`<user>` is `default-user` in single-user mode; multi-user mode gives each account its own subdirectory with the same internal layout.

## Troubleshooting

**No Welcome dialog on first launch**

The wizard only appears the first time a fresh data directory is opened. If Luker has been opened before, run the same import from the user-management panel's **Backup and Restore** entry — the result is identical to the wizard's button.

**Import Data ZIP says "Archive does not match selected restore categories"**

The ZIP doesn't contain any of `characters/`, `chats/`, `worlds/`, etc. anywhere inside. Check what you packed: `zip -r ... default-user` from inside `~/SillyTavern/data` is correct; `zip -r ... data` from inside `~/SillyTavern` works too; but `zip -r ... SillyTavern` from `~/` packs the whole source tree and fails.

**Empty character list after restart (manual-copy flow)**

Check the copy depth: `luker-data/` should contain `default-user/` (or your username directory) directly, not a nested `luker-data/data/default-user/`. If the extra `data/` layer crept in, lift its contents up one level.

**White screen / errors after launch (manual-copy flow)**

`_runtime-persist/` may have been overwritten or corrupted. Try (1) deleting `_runtime-persist/` so Luker can rebuild it; (2) if that doesn't help, App Info → Storage → Clear data and redo the migration.

**Third-party extension didn't load**

Confirm it's at `luker-data/extensions/third-party/<extension-name>/`. Each extension is a directory containing a `manifest.json`.

## Bidirectional compatibility with SillyTavern

After migration, Luker doesn't modify SillyTavern's original data formats — it only adds its own state files (e.g. `.luker-state.<chat_id>.json`) into `data/`. If you ever want to go back to SillyTavern in Termux, copy `luker-data/` contents back; SillyTavern ignores files it doesn't recognize.

For full compatibility notes, see [Migrating from SillyTavern](/guide/migration#data-compatibility).

## Related pages

- [Android App](/guide/android) — APK overview
- [Getting Started](/guide/getting-started) — Luker installation overview
- [Migrating from SillyTavern](/guide/migration) — server-version migration guide
