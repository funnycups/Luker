# LAN Sync

LAN Sync keeps two Luker instances on the same network in sync — desktop and phone, two computers, anything reachable over LAN. Only changed data crosses the wire; full re-uploads aren't needed.

## When to use which

Luker has two ways to move data between devices:

- **[Migrate](/guide/migration)** — one-time, full-data transfer. Best for first install on a new device.
- **LAN Sync** (this page) — repeated, two-way, incremental. Best when both devices are in regular use.

## Quick start

### Pair two devices

1. On the first device (call it A), open **Settings → LAN Sync → Pair new device**.
2. A shows a URL valid for 10 minutes.
3. On the second device (B), open the same panel and choose **Pair with existing device**. Paste the URL.
4. B downloads the data A chose to share and writes it locally. When the panel says "Ready", the pair is done.

After pairing, A and B remember each other. Future syncs only take one click.

### Sync after pairing

On either device, open the LAN Sync panel and click **Sync now**. The two sides exchange changes and reconcile. Most syncs are silent; the panel reports "Up to date" when done.

## Resolving conflicts

If both devices edited the **same file** between syncs (for example: both renamed the same character), LAN Sync stops and shows a conflict panel. Each conflict has two cards: **Local version** and **Remote version**. Pick one card per conflict — there's no line-by-line merging.

Conflicts are always per-file. Picking "Local" for one file and "Remote" for another in the same sync is fine.

### Special case: settings

The `settings.json` file holds everything from "current chat" to "active preset" to UI layout, and it's a single big file. Even small changes on both devices show up as a conflict, and the only available resolution is whole-file pick-one-side — there's no per-field merging. The advice: make configuration changes on one device when possible, sync, and only then change the other.

## What gets synced

By default, LAN Sync moves:

- Character cards, chats, group chats, world books
- CardApps and skills
- Presets (OpenAI / NovelAI / KoboldAI / TextGen), instruct / context / system prompt / reasoning templates
- Themes, moving UI layouts, quick replies
- Backgrounds, user avatars, uploaded files, user images
- ComfyUI workflows
- Assets (sound effects, background music, etc.)
- Image metadata (travels with the images it describes)
- Vector index (saves API budget — both sides reuse the same embeddings)
- Per-character statistics
- `settings.json` (default on, with a warning — see "Special case" above)

Off by default — turn on per-device if you want them:

- **Secrets (API keys)** — off by default. Transmits keys in cleartext over LAN unless your transport is encrypted. Turn on only if you trust the network.
- **Extensions** — off by default. Third-party plugins may have device-specific in-progress changes; syncing them often makes things worse.

Never synced (each device keeps its own):

- Thumbnails (regenerated on first view)
- Per-device automatic chat backups
- Storage-migration archives
- Runtime logs, the active sync state itself, the server's cookie secret

## Recovery

If a sync overwrites something you wanted back, open the LAN Sync panel and click **Undo last sync**. It rewinds to the state immediately before that sync. The other device is not affected (the undo is local).

For a stronger safety net before a risky sync, use Luker's full ZIP backup (Settings → Back up & Restore) and then sync.

## Storage modes

- **File storage** (default): full sync as described above; every category is reconciled file-by-file.
- **SQLite storage**: most data lives in a single database file (`luker-storage.sqlite`). LAN Sync includes this file by default, but conflicts on the database can only be resolved as whole-database pick-one-side — there's no row-level merge. Picking one side discards the other side's database writes since the last sync. Folder-backed categories (character cards on disk, etc.) still reconcile file-by-file.
- **MySQL / Postgres storage**: LAN Sync is disabled. Coordinate database replication on the database server itself.

## Performance

A typical sync on a mature data set (a few thousand files, around 100 MB) finishes in well under a second after the initial pairing. Only objects new since the last sync cross the wire. The first pair-and-pull is the slowest operation; subsequent syncs are essentially instant.
