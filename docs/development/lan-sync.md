# LAN Sync — Developer Guide

Technical reference for Luker's LAN Sync feature. For the user-facing description see [LAN Sync](/improvements/lan-sync). For the design rationale and protocol negotiation rules, see the spec in `docs/superpowers/specs/lan-sync.md`.

## Architecture in one paragraph

Each Luker user has a **shadow git repository** per paired peer, kept under `data/<handle>/.sync/<peer-id>/`. Sync runs as a four-step pipeline on the initiating side: snapshot the live data into the shadow workdir, fetch the peer's missing git objects over HTTP, attempt a three-way merge, reconcile the merge result back to live storage. The responding side performs the symmetric snapshot at offer time and a tail reconcile when the initiator's push lands on `refs/heads/main`. All conflicts are file-level — there is no field-level merge in v1.

## File layout

```
data/<handle>/.sync/
├── state.json                  Peer registry, last-sync timestamps, per-peer category selections
└── <peer-id>/
    ├── repo.git/               Bare git database holding sync history for this peer
    └── workdir/                Working tree mirroring the user's selected categories
```

The shadow repo is independent of the live data. The orchestrator copies live → shadow before each sync and writes shadow → live after each successful merge. The bare `repo.git` plus the materialized `workdir` form a **split-layout** repository: every isomorphic-git call inside the sync code carries both `dir: shadow.workdir` and `gitdir: shadow.gitDir` because the `.git` is not nested inside the workdir.

`state.json` is rewritten atomically via `write-file-atomic`. Helpers live in `src/sync/state.js` — `readSyncState`, `recordPeer`, `recordSyncCompletion`, `removePeer`, `removePeerCompletely`. The file holds the per-peer `categories` selection that `runPull` and `undoLastSync` reuse so future syncs honor the user's original choice without re-confirming. `recordPeer` also persists `peerBaseUrl` so `/peers/:peerId/sync` ("Sync now" in the UI) can re-run a sync without prompting the user for the peer's URL again. `removePeerCompletely` removes both the registry entry AND the on-disk shadow dir under `<userRoot>/.sync/<peerId>/` — the legacy `removePeer` only touches `state.json` and would leak an orphan shadow.

## The wire protocol

All endpoints live under `/api/sync/v1/`. Token authentication uses an `Authorization: Bearer <token>` header. Tokens are 64-hex-character session identifiers issued for 10 minutes, multi-use until `/session/close`.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET`  | `/health`                | Basic         | Liveness probe — returns `{ ok: true }` |
| `POST` | `/session/offer`         | Basic         | Responder mints a session token AND snapshots its live data into the shadow workdir; returns `{ url, token, expiresAt, peerId, label }` |
| `GET`  | `/session/manifest`      | Session token | Initiator fetches `{ handle, peerId, expiresAt, headOid }` |
| `GET`  | `/session/object/:oid`   | Session token | Initiator fetches one git object; body is raw content, `X-Object-Type` and `X-Object-Oid` headers carry metadata |
| `POST` | `/session/object`        | Session token | Initiator uploads one git object; `X-Object-Oid`/`X-Object-Type` headers, raw body streamed direct from the request into a tmp file under `<gitdir>/objects/incoming/` (no in-memory buffer of the full body) |
| `POST` | `/session/ref`           | Session token | Initiator atomically updates a ref with compare-and-swap (returns 409 with `currentOid` on mismatch); when the ref is `refs/heads/main`, the responder runs a tail reconcile back into its own live tree |
| `POST` | `/session/close`         | Session token | Invalidates the token immediately |
| `POST` | `/pull`                  | Basic         | Initiator endpoint: drives the full sync flow against a peer's offer |
| `POST` | `/undo`                  | Basic         | Rewinds to the latest `sync-backup-*` tag for a given peer |
| `GET`  | `/peers`                 | Basic         | Returns the per-user peer registry (label, categories, pairedAt, lastSyncAt, lastSyncedOid, peerBaseUrl) |
| `GET`  | `/categories`            | Basic         | Returns the `SYNC_CATEGORIES` shape for the UI to render the category picker without bundling the list |
| `DELETE` | `/peers/:peerId`       | Basic         | Removes both the registry entry AND the on-disk shadow dir under `<userRoot>/.sync/<peerId>/`; idempotent |
| `POST` | `/peers/:peerId/label`   | Basic         | Updates a peer's label/categories without resetting `pairedAt` |
| `POST` | `/peers/:peerId/sync`    | Basic         | "Sync now" against an already-paired peer; uses the `peerBaseUrl` stored in the registry so the user never re-types the URL |
| `POST` | `/pair/start`            | Basic         | Allocates a new peerId, registers it locally, returns `{peerId, label, peerBaseUrl, categories}` for the UI to render as a pairing link |
| `POST` | `/pair/accept`           | Basic         | Consumes a pairing link: calls the peer's `/session/offer` to mint a token, registers the peer locally, runs the first `runPull` |

The session-token paths (`/api/sync/v1/session/*` except `/session/offer`) bypass the standard basic-auth middleware via `src/middleware/basicAuth.js`'s `SYNC_SESSION_PATH_PATTERN`. `/session/*` is also exempt from CSRF protection (see `src/server-main.js`'s `skipCsrfProtection`) so server-to-server `fetch` calls from `/pair/accept` and `/peers/:peerId/sync` can hit the peer's `/session/offer` without carrying a session-bound CSRF token. `/session/offer` itself stays in the basic-auth flow so `req.user` is populated — this is what binds the issued token to the authenticated handle. `/pull`, `/undo`, `/pair/*`, `/peers*` all use basic auth as well.

### Wire-format constraints

- **Object size**: there is no cap on the wire. `POST /session/object` mounts no body parser; `writeObjectFromWireStream` pipes the request body to a tmp file under `<gitdir>/objects/incoming/`, then hands the file's bytes to `git.writeObject`. The responder's heap never grows by the body's full size during transfer — back-pressure flows through the pipe and the kernel pages the file in and out. The tmp file is unlinked on both success and failure paths.
- **Object integrity**: both `writeObjectFromWire` (buffer variant) and `writeObjectFromWireStream` (streaming variant) re-hash the body and compare against the supplied `oid`; a mismatch throws before the object is reachable from any ref, and the streaming variant also unlinks its tmp file on the failure path. `fetchMissingObjects` passes the **requested** oid (not the responder's claimed `X-Object-Oid`) into the write, so a responder that lies about an object's identity cannot poison the local database.
- **Peer fetch timeouts**: outbound `fetch` calls from the orchestrator carry `AbortSignal.timeout(30_000)`. A timeout becomes a typed `PEER_TIMEOUT` error that `/pull` maps to HTTP 504. Without this, a peer that walked off Wi-Fi mid-pull would strand the per-key sync queue for the OS-default TCP timeout (multiple minutes).
- **`/session/offer` body cap**: `express.json({ limit: '16kb' })` — the offer payload is just peerId, label, and a categories array, so 16 KB is generous.
- **`/pull` body cap**: `express.json({ limit: '1mb' })` — the resolutions object can grow when many files conflict, so 1 MB leaves headroom.

## Category registry

`src/sync/categories.js` exports a single array `SYNC_CATEGORIES`. Each entry maps an id to one or more paths (resolved via `UserDirectoryList` accessors) and declares a default (`on` / `opt-in` / `never`) and conflict mode (`file` / `none`). All UI labels and warnings are i18n keys; the runtime never embeds English strings.

The registry currently covers: `characters`, `chats`, `worlds`, `card-apps`, `skills`, the four preset families (`openai-presets`, `novelai-presets`, `koboldai-presets`, `textgen-presets`), the four template families (`instruct`, `context`, `sysprompt`, `reasoning`), `themes`, `movingUI`, `quickreplies`, `assets`, `backgrounds`, `avatars`, `user-files`, `user-images`, `image-metadata`, `vectors`, `stats`, `settings`, `secrets`, and `extensions`.

Adding a new category:

1. Add an entry to `SYNC_CATEGORIES`.
2. Add the i18n keys to `public/locales/{zh-CN,zh-TW,en}.json`.
3. The shape test in `tests/sync/categories.test.js` catches missing locale strings.

## Storage-mode handling

The workdir is the universal exchange format. Engines that already store per-user data on disk skip materialization; engines that store it in a database project their records into the workdir before snapshot and read them back after reconcile. From the sync pipeline's point of view, every engine is just files.

- **`fs`**: per-user data already lives at the expected workdir-relative paths under `<userRoot>`. `snapshotLiveToShadow` walks the live tree directly and copies it into the shadow workdir; reconcile writes go through `write-file-atomic` so a crashed reconcile leaves the old file intact.
- **`sqlite`** / **`mysql`** / **`postgres`**: per-user data (chats, presets, worlds, named-docs, settings, stats, groups) lives in the storage engine. Before snapshot, the orchestrator calls `materializeUserDataIntoWorkdir` (`src/sync/materialize.js`) which reads each enabled category through the repo layer and writes each record as a file under `<workdir>/<expected-rel-path>` matching the FS-engine layout. `snapshotLiveToShadow` then walks the workdir as if it were the live tree by passing `liveRoot: shadow.workdir`. After reconcile, `dematerializeWorkdirIntoUserData` reads the (possibly merged) workdir state back and saves each record through the repo layer. Categories whose payload lives on disk in every engine (characters, avatars, assets, …) bypass the materializer and are handled by the snapshot walker directly.

Conflict mode is `file` for every category in every engine — chat-vs-chat, world-vs-world, per-record — so the merge UI and resolution semantics do not depend on the storage engine.

## Conflict resolution flow

When `git.merge` throws `MergeConflictError`, `attemptMerge` in `src/sync/conflicts.js` walks `error.data` and returns:

```js
{
    success: false,
    conflicts: [
        { filepath, kind, oursOid, theirsOid },
        ...
    ],
}
```

`kind` is one of `bothModified`, `deleteByUs`, `deleteByTheirs`. `oursOid` is `null` for `deleteByUs`; `theirsOid` is `null` for `deleteByTheirs`. The orchestrator propagates the conflict set as `{ ok: false, conflicts }` so `/pull` returns it as JSON; the UI presents each conflict and the user picks one side per file. A follow-up `/pull` call with `resolutions: { filepath: 'ours' | 'theirs' }` calls `applyResolutions`, which writes the chosen blobs into the workdir and produces a two-parent merge commit.

`attemptMerge` also handles two cases `git.merge` does not. **Fast-forward forward / backward**: `isAncestor` in `src/sync/orchestrator.js` walks `git.log` from each candidate to detect a strictly-linear relationship between local and peer heads, short-circuiting to a `writeRef` + `checkout` + reconcile without generating a merge commit. **No common ancestor**: `git.merge` throws `MergeNotSupportedError` for both sides being root commits, which happens whenever two devices each made their first snapshot before being paired. `attemptMerge` catches this and synthesizes the symmetric difference as a per-file conflict set (every file present on exactly one side becomes a `deleteByX` pick; every file with diverging blob oids becomes `bothModified`) — same `{ ok: false, conflicts }` shape so the UI handles it uniformly.

The orchestrator does **not** call `git.checkout` after a merge failure. The workdir is in a merge-in-progress state with auto-merged files already in place; a checkout would destroy them. `applyResolutions` overwrites only the conflict files and stages them through `writeAndStage` so unique-side files survive.

After a clean (non-conflicted) merge, `git.merge` updates `refs/heads/main` and the index but does **not** touch the workdir, so the orchestrator runs an explicit `git.checkout({ ref: 'main', force: true })` before `reconcileShadowToLive` reads the workdir back into live.

## Recovery

Before each pull, the orchestrator tags the current shadow `main` as `sync-backup-<ISO timestamp>` (with `:` / `.` replaced by `-` so the tag name is filesystem-safe and lexicographically sortable). The tag is skipped on the first pair (no `main` to anchor to yet).

`POST /undo` walks tags matching `sync-backup-*`, sorts them, picks the latest, points `main` at the tagged commit, materializes the tree into the workdir via `git.checkout`, and runs `reconcileShadowToLive` scoped to the peer's last-recorded category selection. The tag-to-commit relationship is the source of truth; the live data is rebuilt by reconciling the rewound shadow.

If no `sync-backup-*` tag exists (a peer that has only ever done one sync, where the pair-init pull doesn't plant a tag), `undoLastSync` throws `NO_BACKUP_TAG`, which `/undo` maps to HTTP 404.

Undo is strictly local — it touches only this side's data. The peer is unaffected until the next sync.

## Locking

The orchestrator holds a **per-`(userRoot, peerId)` FIFO queue** for every operation that mutates live data for a pairing: `runPull` invocations on this side AND responder reconciles triggered by `/session/ref` posts from the peer. The queue uses `userRoot` rather than `handle` so two distinct users sharing a handle (test harnesses, future multi-tenant scenarios) get independent queues bound to their physical data root.

The queue **waits** rather than throws. A second `/pull` for the same `(userRoot, peerId)` blocks behind the first instead of returning a 409 — this matches users' mental model of "clicking Sync twice does the right thing" and serializes correctly with peer-triggered responder reconciles. The queue tail is `.catch`-swallowed so a single failure does not poison every subsequent enqueue.

The canonical queue helpers are `queueOnKey(key, fn)` and `syncQueueKey(userRoot, peerId)`, both exported from `src/sync/orchestrator.js`. The sync HTTP layer uses the same key for the `/session/ref` reconcile so a peer push arriving mid-`runPull` waits for the local pull to finish.

### What is NOT locked

Two distinct peers (laptop + phone) paired to the same user have separate `(userRoot, peerId)` keys and can run reconciles concurrently against the same user's live tree. `write-file-atomic` keeps per-file writes consistent; cross-file consistency in that scenario is the user's responsibility (don't run two sync flows in parallel). Per spec §4.4, a per-userRoot live-write lock would be required to make this watertight, but is more complexity than v1 warrants.

Spec §4.4 also describes an app-wide `SYNC_IN_PROGRESS` gate that returns HTTP 409 from user-initiated write endpoints (`/api/chats/save`, `/api/settings/save`, `/api/presets/save`, etc.) for the duration of a sync window. The gate prevents the live tree from moving under the orchestrator's feet while it snapshots → merges → reconciles, which would otherwise risk the "edit I made during sync vanished" failure mode (caught in the snapshot but overwritten by the reconcile) and, in SQL-engine modes, leave the materialized workdir and the engine's record set inconsistent after a user write lands between materialize and dematerialize.

The gate lives in `src/sync/in-progress-gate.js` and is mounted in `src/server-main.js` immediately after `requireLoginMiddleware`. It is **per-handle**: a sync in flight for handle `A` does not block writes for handle `B`. The orchestrator marks `(handle, peerId)` in flight inside `queueOnKey`'s body (so a pull WAITING in the queue does not pre-emptively 409 user writes) and clears in `try/finally` (so a thrown error, a peer timeout, or a pending-conflict early return all release the gate). Three orchestrator entry points participate: `runPull`, `undoLastSync`, and the responder reconcile triggered by `/session/ref` on the peer side.

The gated path registry is conservative: every POST/PUT/PATCH/DELETE that writes to disk under `data/<handle>/` is included; read endpoints (`/get`, `/list`, `/recent`, `/search`) are NOT gated so the UI can continue showing data while a sync runs. Refused writes get a structured 409 body (`{error: 'SYNC_IN_PROGRESS', retryAfterMs, peers}`) and a `Retry-After` HTTP header so the client can debounce its retry.

What the gate does NOT cover: cross-peer races where two distinct peers paired to the same handle both push to the same user's live tree at the same time. Each `(userRoot, peerId)` pair has its own queue, and `write-file-atomic` keeps per-file writes consistent across that boundary, but cross-file consistency in that scenario is the user's responsibility (don't run two sync flows in parallel against the same handle).

## Performance characteristics

For a typical user (~3000 files, ~100 MB):

- **Initial pair**: a few seconds (snapshot + initial commit + object transfer for the full tree). Cost is dominated by reading every file off disk to hash it; subsequent operations only re-hash files whose mtime changed.
- **Incremental sync**: well under a second when the change set is small. Wire cost is bound by the number of new git objects, not the live data size — a typed character message that changes a single `chat_*.jsonl` ships one new commit, one new tree per touched directory, and one new blob.
- **Wire volume on a small sync**: typically a few KB total (commit + a couple of trees + the changed blobs).
- **Shadow `.git` directory**: roughly 40% the size of synced live data; git's internal zlib amortizes well across the small JSON files that dominate a Luker dataset.

## Source files

- `src/sync/categories.js` — registry of synced data categories
- `src/sync/session.js` — token cache (modeled on `src/lan-migration.js`)
- `src/sync/shadow.js` — shadow paths, `ensureShadowRepo`, `snapshotLiveToShadow`, `reconcileShadowToLive`
- `src/sync/objects.js` — wire encode/decode (`readObjectForWire`, `writeObjectFromWire`, `writeObjectFromWireStream`) and object-graph walker (`fetchMissingObjects`, `hasObjectLocally`)
- `src/sync/conflicts.js` — `attemptMerge` and `applyResolutions`
- `src/sync/materialize.js` — `materializeUserDataIntoWorkdir` / `dematerializeWorkdirIntoUserData` for sqlite/mysql/postgres engines (no-ops in fs mode)
- `src/sync/state.js` — `state.json` read/write helpers
- `src/sync/orchestrator.js` — `runPull`, `undoLastSync`, `queueOnKey`, `isAncestor`
- `src/sync/in-progress-gate.js` — per-handle `SYNC_IN_PROGRESS` registry + Express middleware (spec §4.4)
- `src/endpoints/sync.js` — HTTP router for `/api/sync/v1/*`
- `src/middleware/basicAuth.js` — `SYNC_SESSION_PATH_PATTERN` for the auth bypass
- `src/server-main.js` — CSRF skip pattern for `/api/sync/v1/session/*` so server-to-server peer fetches work
- `public/scripts/lan-sync.js` + `public/scripts/templates/userLanSync.html` — UI panel reached from Account → Backup & Restore → LAN Sync

## Tests

- `tests/sync/*.test.js` — unit coverage for each module
- `tests/sync/integration/*.test.js` — two-server integration tests via supertest, including the full pair → sync → conflict → resolution → undo round trip
