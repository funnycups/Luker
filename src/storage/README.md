# `src/storage/` — Repository and Engine layers

Repository methods are the only API that endpoints should use to read or write structured data. Direct `fs.*` calls inside endpoint handlers are deprecated and migrate into Repositories incrementally.

## Layers

- **`engines/`** — how data is read and written. Four engines ship: `FsEngine` (one file per resource under `<dataRoot>/<handle>/`), `SqliteEngine` (per-user `luker-storage.sqlite`, WAL, FK on, real transactions), `MysqlEngine` and `PgEngine` (shared-DB backends keyed by `handle` column). All are swappable behind the same Engine / Transaction interface. The active engine is picked at boot from `storage.mode` in `config.yaml` (`fs` default; `sqlite` / `mysql` / `postgres` opt-in).
- **`repositories/`** — what a chat / preset / lorebook *is*. Owns integrity (OCC), gen_id dedup, JSON-Patch idempotency, and any other "what does this resource mean" logic.
- **`errors.js`** — typed errors that endpoints translate into HTTP status codes:
  - `ConflictError` → 409
  - `NotFoundError` → 404
  - `PatchTestFailedError`, `PatchMissingParentError` → 409 patch conflict
  - `UnsupportedPatchOpError` → 400 patch payload invalid
- **`index.js`** — bootstrap (`initStorage`) and accessors (`getChatRepo`, `getSettingsRepo`, `getPresetRepo`, `getWorldInfoRepo`, `getNamedDocRepo`, `getGroupRepo`, `getStatsRepo`, `getStorageEngine`).

## Usage from an endpoint

```js
import { getChatRepo } from '../storage/index.js';
import { ConflictError, NotFoundError } from '../storage/errors.js';

router.post('/something', async function (req, res) {
    try {
        const result = await getChatRepo().save(handle, charDir, name, header, body, integrity);
        res.send(result);
    } catch (e) {
        if (e instanceof ConflictError) return res.status(409).send({ error: e.code });
        if (e instanceof NotFoundError) return res.sendStatus(404);
        throw e;
    }
});
```

`handle` comes from `request.user.profile.handle`. The Engine resolves it to a per-user directory at request time, so the Repo never sees paths.

## Adding behavior

1. Add the method to the Repo first.
2. Add a test case with a real `makeTempFsEngine()` harness (no mocks).
3. If the Engine doesn't already expose the primitives the new Repo method needs, add them to `FsTransaction` and route through a `registerXxxHandler(tx)` function at the bottom of `fs-engine-transaction.js`.
4. Wire the endpoint to call the new Repo method.

## Repo coverage

### Repos shipped

| Repo | Resource kind | Backing file shape (FS mode) |
|---|---|---|
| `ChatRepo` | `chat` | `<chats>/<charDir>/<name>.jsonl` (group chats: `<groupChats>/<chatId>.jsonl`) |
| `SettingsRepo` | `settings` | `<root>/settings.json` |
| `PresetRepo` | `preset` | `<apiFolder>/<name>.json` (apiId → folder map) |
| `WorldInfoRepo` | `world` | `<worlds>/<name>.json` with tolerant filename lookup |
| `NamedDocRepo` | `named-doc` | `<themes\|movingUI\|quickreplies>/<name>.json` (one Repo, three buckets) |
| `GroupRepo` | `group` | `<groups>/<id>.json`; `delete` cascades member chat JSONLs |
| `StatsRepo` | `stats` | `<root>/stats.json` (compact JSON, internal IO only) |

### Endpoints routed through Repos

| Endpoint family | Handlers routed through Repo |
|---|---|
| `/api/chats` | `/get`, `/save`, `/append`, `/patch`, `/delete`, `/rename`, `/state/get`, `/state/get-batch`, `/state/patch`, `/state/delete` |
| `/api/settings` | `/get`, `/bootstrap`, `/save`, `/patch` |
| `/api/presets` | `/save`, `/patch`, `/delete`, `/state/get`, `/state/get-batch`, `/state/patch`, `/state/delete`, `/state/delete-all`, `/state/rename` |
| `/api/worldinfo` | `/list`, `/list-lite`, `/get`, `/get-batch`, `/delete`, `/import`, `/edit`, `/patch` |
| `/api/themes`, `/api/moving-ui`, `/api/quick-replies` | `/save`, `/delete` |
| `/api/groups` | `/all`, `/create`, `/edit`, `/delete` (also `getGroupsSnapshot` consumed by `/api/bootstrap`) |
| `/api/stats` | internal IO only (`init`, `saveStatsToFile`); endpoints unchanged because they read/write the in-memory `STATS` Map |

### Still on direct `fs.*` access

- **Chats**: `/recent` (in-memory cached index — keeps parity with SqliteEngine's indexed scan), `/meta`, `/meta/patch`, `/get-delta`, `/export`, `/import`, `/search`, `/group/*` (all `/api/chats/group/*` group-chat handlers).
- **Settings snapshot endpoints**: `/get-snapshots`, `/load-snapshot`, `/make-snapshot`, `/restore-snapshot` — covered by the engine-level snapshot API once they migrate.
- **Presets**: `/restore` (reads from `getDefaultPresets`/`getDefaultPresetFile` content-manager, not user data).
- **Secrets, user accounts, admin settings, announcements**: `src/endpoints/secrets.js`, `src/endpoints/users-private.js`, `src/endpoints/users-admin.js`, `src/admin-settings.js`, `src/announcements.js`. Secrets has ~20 external callers (`readSecret(directories, ...)` across `src/additional-headers.js`, `src/endpoints/{azure,novelai,translate,...}.js`, `src/users.js`); migrating to the handle-based API is a separate per-caller pass. User accounts / admin settings / announcements live in `node-persist` (`<dataRoot>/_storage/`), not user files, and would need a `NodePersistEngine` to share the Engine contract.
- **`getGroupsSnapshot`**: now async and uses GroupRepo; sync callers (`migrateGroupChatsMetadataFormat` boot-time path inside `groups.js`) still use direct `fs.*` because that's a one-shot data migration unrelated to runtime IO.

## ChatRepo method coverage

| Method | Purpose | Throws |
|---|---|---|
| `get(handle, charDir, name)` | Read full chat (header + body + integrity). Returns null if missing. | — |
| `save(handle, charDir, name, header, body, expectedIntegrity)` | Full write. OCC via `expectedIntegrity` (null = unconditional). Rotates integrity, returns new value. | `ConflictError` if integrity mismatch; `NotFoundError` if integrity was supplied but the chat is missing |
| `append(handle, charDir, name, newMessages, expectedIntegrity)` | Append messages, dedup by `extra.gen_id`. | `NotFoundError` if chat missing; `ConflictError` on integrity mismatch |
| `patch(handle, charDir, name, ops, expectedIntegrity)` | RFC 6902 JSON Patch over `{header, body}`. Rewrites `add /body/<idx>` as `test` when target equals value (idempotent retries). | `NotFoundError`, `ConflictError`, `PatchTestFailedError`, `PatchMissingParentError`, `UnsupportedPatchOpError` |
| `delete(handle, charDir, name)` | Delete chat and cascade all `chat_state` sidecars. No-op on missing. | — |
| `rename(handle, charDir, oldName, newName)` | Move chat + all sidecars to new name. Refuses if target exists. | `NotFoundError`, `ConflictError('rename_target_exists')` |
| `listRecent(handle, { limit })` | Sparse list of chats for a handle, newest first. Header/body are undefined; call `get` for full content. | — |
| `getState(handle, charDir, name, namespace)` | Read one sidecar. Returns null if missing. | — |
| `setState(handle, charDir, name, namespace, doc)` | Write one sidecar. **Requires parent chat to exist.** | `NotFoundError` |
| `deleteState(handle, charDir, name, namespace)` | Delete one sidecar. No-op on missing. | — |
| `getStateBatch(handle, charDir, name, namespaces[])` | Read multiple sidecars in one call. Missing namespaces map to null. | — |

## Other Repo method coverage

| Repo | Methods |
|---|---|
| `SettingsRepo` | `get(handle)`, `save(handle, doc)`, `patch(handle, ops)` — `patch` throws `NotFoundError` when settings file missing |
| `PresetRepo` | `get/save/delete/exists/patch(handle, apiId, name, ...)`, `getState/setState/deleteState/deleteAllStates/listStateNamespaces(... , namespace)`, `renameStates(... , oldName, newName)` |
| `WorldInfoRepo` | `get/save/delete/exists/patch/list/resolveName(handle, name, ...)` — `save` and `patch` enforce `{entries: object}` invariant; `resolveName` exposes tolerant filename lookup |
| `NamedDocRepo` | `save/delete(handle, bucket, name, {strict?})` — buckets: `themes`, `movingUI`, `quickReplies` |
| `GroupRepo` | `get/save/delete/list/listWithChatStats(handle, ...)` — `delete` returns `{deleted, chatsDeleted}` and cascades member chat JSONLs (and their sidecars) via the chat handler |
| `StatsRepo` | `get(handle)`, `save(handle, doc)` |

## On-disk conventions (FsEngine)

- Chat: `<chats>/<charDir>/<name>.jsonl`
- Group chat: `<groupChats>/<groupId|name>.jsonl`
- Sidecar (chats + presets): `<dir>/<base>.luker-state.<namespace>.json` — uses the `SIDECAR_INFIX = '.luker-state.'` constant from `engines/sidecar-naming.js`; matches the existing Luker convention so vanilla SillyTavern and rsync / Syncthing setups stay compatible
- Integrity slug: stored in `chat_metadata.integrity` of the first JSONL line; rotated by every write through ChatRepo
- Pretty-print convention: most resources (settings, presets, worlds, named-docs, groups) write `JSON.stringify(doc, null, 4)`. `StatsRepo` writes compact JSON to match legacy. `ChatRepo` writes JSONL.

## What FS mode does NOT provide

- **Cross-resource transactions.** `withTransaction(fn)` on FsEngine runs `fn` sequentially; if a write inside the closure throws after earlier writes succeeded, the earlier writes are NOT rolled back. SqliteEngine provides true transactions.
- **Concurrent-write linearization.** Chats use the integrity slug (409 → client retries) for safety, not file locks. Other resources have no OCC at all — concurrent writers to the same file race. FS mode introduces no `_journal/`, `_locks/`, or other files that would break vanilla SillyTavern compatibility.

## Testing

- Unit tests live under `tests/storage/`. Run with:
  ```bash
  node --experimental-vm-modules tests/node_modules/jest/bin/jest.js --config tests/jest.config.json storage/
  ```
  (or `npm run test:unit --prefix tests` for the full suite.)
- Tests use a real `makeTempFsEngine()` harness from `tests/storage/harness/fs-harness.js` — no mocks. Each test creates a fresh tmp dir and cleans up after itself.
- `describe.each(CONTRACT_HARNESSES)` (from `tests/storage/harness/contract-harness.js`) runs each Repo's `.contract.js` suite against `FsEngine` and `SqliteEngine` from the same source file. Adding a test inside a `.contract.js` file automatically covers both engines.
- `tests/storage/round-trip.test.js` proves cross-engine data preservation: write a doc via engine A, read it back, write that snapshot via engine B, read it back, assert deep equality (modulo engine-internal metadata like `integrity` / `updatedAt`). Covers Chat / Settings / Preset / WorldInfo / Group / Stats in both directions (FS ↔ SQLite). `NamedDocRepo` is skipped from round-trip because it has no `get` method.
- Endpoint migrations are covered by the existing endpoint-level integration suites (chats / settings / floor-state / memory-graph).

## Selecting an engine

The active engine is read from `config.yaml`:

```yaml
storage:
  mode: fs   # or: sqlite, mysql, postgres
  # For mode: mysql
  mysql:
    url: mysql://user:pass@host:3306/luker
    poolSize: 10
  # For mode: postgres
  postgres:
    url: postgresql://user:pass@host:5432/luker
    poolSize: 10
```

- `fs` (default) — `FsEngine`. One file per resource under `<dataRoot>/<handle>/`.
- `sqlite` — `SqliteEngine` opens / creates `<dataRoot>/<handle>/luker-storage.sqlite` per user.
- `mysql` — `MysqlEngine` connects to a shared MySQL 8.0+ database; all users live in one schema, keyed by `handle` column. Requires `storage.mysql.url`.
- `postgres` — `PgEngine` connects to a shared PostgreSQL 14+ database; all users live in one schema, keyed by `handle` column. Requires `storage.postgres.url`.

`initStorage({ mode, directoriesByHandle, mysql, postgres })` throws `Error: unknown storage mode "<x>"` for anything else, and throws `mode=mysql requires storage.mysql.url` / `mode=postgres requires storage.postgres.url` when the mode is selected without a URL. Migration between any pair of engines is supported from both the admin panel and the `storage-migrate` CLI; see "Migration tooling" below.

## SqliteEngine on disk

- One database file per user: `<dataRoot>/<handle>/luker-storage.sqlite` — same per-user containment as FS mode.
- PRAGMAs at open: `journal_mode = WAL`, `synchronous = NORMAL`, `foreign_keys = ON`.
- Real transactions: `withTransaction(handle, fn)` issues `BEGIN IMMEDIATE` → runs `fn(tx)` → `COMMIT` (or `ROLLBACK` on throw). Unlike `FsEngine.withTransaction`, partial writes ARE rolled back.

## Schema (SqliteEngine, MysqlEngine, PgEngine)

One table per resource kind (`chats`, `chat_states`, `settings`, `presets`, `preset_states`, `worlds`, `named_docs`, `groups`, `stats`). Each row carries a `doc TEXT` column holding the JSON payload — that is the source of truth, and the Repo API reads / writes that field whole. Lookups by name are indexed but never authoritative.

`chats` has a `STORED GENERATED COLUMN` (`integrity`) extracted from the doc's `chat_metadata.integrity` so OCC checks can run inside SQL without parsing JSON in JavaScript. This requires SQLite ≥ 3.31. better-sqlite3's bundled SQLite is well past that, so the requirement only bites if you point better-sqlite3 at a system SQLite via custom build.

## What's the same across engines

- The Repo API (every `getXxxRepo()` accessor returns the same Repo class regardless of engine).
- Engine observable contract: each Repo method's pre/post conditions match across engines, enforced by the parameterized contract tests under `tests/storage/repositories/*.contract.js`.
- Typed errors (`ConflictError`, `NotFoundError`, `PatchTestFailedError`, …) are thrown identically.
- OCC: chat saves still rotate `integrity` and reject on mismatch.
- Sidecar semantics: chats / presets still expose `getState`, `setState`, `deleteState`, `getStateBatch`, etc. with the same return shapes.

## What's intentionally different across engines

- **`chat_states` FK CASCADE** — SQLite enforces it via `FOREIGN KEY (...) REFERENCES chats(...) ON DELETE CASCADE`; the FS handler implements the same end behavior by walking sibling sidecars at delete time. End result: deleting a chat removes all its state sidecars on both engines.
- **`preset_states` permissive orphan sidecars** — there is NO FK on `preset_states` in the SQLite schema. This matches FS behavior, where orphan preset sidecars are tolerated (presets are renamed / deleted via separate code paths that don't always run sidecar cleanup atomically). Adding the FK would diverge from FS.
- **`chat_size` in groups** — `GroupRepo.listWithChatStats` reports an approximate byte size for each member chat.
  - FS uses `fs.statSync(<chat>.jsonl).size` — exact JSONL file size on disk.
  - SQLite uses `length(doc)` of the JSON-serialized doc — UTF-8 byte length of the canonical JSON string.
  - Numbers differ (the JSON encoding adds field-name overhead vs. JSONL's flatter shape, and FS counts trailing newlines). Both are intended as "rough size indicator" for the UI, not authoritative metrics.
- **`updatedAt` resolution** —
  - FS reads `fs.statSync(...).mtimeMs` (real OS flush timestamp; reflects when the file system wrote the bytes).
  - SQLite stores `Date.now()` at save time (reflects when the Repo called `save`).
  - Both are millisecond-resolution numbers, but they answer slightly different questions. Don't compare timestamps across engines.

## Dependencies and install gotchas

- Native dep: `better-sqlite3`. Pulled in automatically by `npm install`.
- SQLite version requirement: ≥ 3.31 (for `STORED GENERATED COLUMN` support in the `chats` table). better-sqlite3 bundles a recent SQLite, so this is satisfied out of the box.
- macOS install gotcha: Homebrew Python 3.14.6 ships a broken `pyexpat`, which makes node-gyp's setup crash before better-sqlite3 can build. Workaround: rerun the install with `npm rebuild better-sqlite3 --python=/usr/bin/python3` (system Python) or set `PYTHON=/usr/bin/python3` for the install command.

## Migration tooling

Operators can copy a populated install between any pair of engines either from the admin panel or from a CLI, with a one-shot read-only freeze on the source engine while the copy runs.

### Read-only mode

Module: `src/storage/read-only-mode.js`. Process-global flag that every Repo write checks before mutating state.

| Function | Purpose |
|---|---|
| `setReadOnly(bool)` | Toggle the global flag. |
| `isReadOnly()` | Read the current flag. |
| `assertWritable()` | Throw `StorageReadOnlyError` if the flag is set; called at the top of every Repo write method. |
| `withReadOnlyBypass(fn)` | Run `fn` with writes permitted regardless of the flag. Reentrant via a depth counter so the migration runner can write to the destination engine while the source is frozen for the rest of the process. |

All seven Repos participate: every write method (`save`, `patch`, `delete`, `rename`, `setState`, `deleteState`, `deleteAllStates`, `renameStates`) calls `assertWritable()` first. `StorageReadOnlyError` carries `code: 'storage_read_only'` and is mapped to HTTP 503 by the Express middleware.

### Migration core

`src/storage/migration/`:

| File | Exports |
|---|---|
| `runner.js` | `MigrationRunner` — per-user async runner. Takes pre-built source and destination Repo sets and walks each user through three steps: snapshot, copy, verify. |
| `backup.js` | `snapshotUser({ handle, userRoot, backupRoot })` — recursive directory copy. Backups are timestamped (`<iso8601>-<handle>/`) and never auto-deleted. |
| `equality.js` | `stripChatEngineMeta(record)`, `recordsEqual(kind, a, b)`. Shared between the round-trip tests and the runner's verification step. Strips both the top-level `integrity` field and the embedded `header.chat_metadata.integrity` for chat records — a load-bearing detail surfaced by the round-trip suite. |

The runner writes to the destination through `withReadOnlyBypass` so the source remains frozen end-to-end.

### Admin endpoints

`src/endpoints/users-admin.js`:

| Method + Path | Body | Returns |
|---|---|---|
| `POST /api/users/storage/status` | — | `{ currentMode, readOnly, lastMigration, migrationInProgress }` |
| `POST /api/users/storage/migrate` | `{ targetMode: 'fs' \| 'sqlite' \| 'mysql' \| 'postgres', mysql?: { url, poolSize? }, postgres?: { url, poolSize? } }` | per-user result map, plus `configPersisted` (bool) and `configPersistError?` (string). The global engine is swapped to `targetMode` and `storage.mode` / inline creds are written back to `config.yaml`. |

`/migrate` is synchronous and blocks the request until the runner finishes. If any user fails, the source engine is retained and per-user errors are returned in the response body. For `targetMode: 'mysql'` / `'postgres'` the body may carry inline credentials; otherwise the endpoint reads `storage.mysql` / `storage.postgres` from `config.yaml`. Inline creds win for both engine construction and the config writeback; credentials sourced from config.yaml are not rewritten because they're already there.

### Express middleware

`src/middleware/storage-errors.js`:

| Error class | HTTP status | Body |
|---|---|---|
| `StorageReadOnlyError` | 503 | `{ error, code }` |
| `ConflictError` | 409 | `{ error, code, details }` |
| `NotFoundError` | 404 | `{ error }` |

Registered in `src/server-main.js` after `setupPrivateEndpoints` and before the 404 handler so endpoint code can simply `throw` and let the middleware translate.

### CLI

`scripts/storage-migrate.js`:

```
node scripts/storage-migrate.js --from <mode> --to <mode> [options]
node scripts/storage-migrate.js --help
```

Modes: `fs`, `sqlite`, `mysql`, `postgres`. For `mysql` / `postgres` either pass `--mysql-url` / `--postgres-url` on the command line or set `storage.mysql.url` / `storage.postgres.url` in `config.yaml` — the CLI flag wins when both are present. `--mysql-pool-size` / `--postgres-pool-size` override the pool size (defaults to the config value, or 10).

| Exit code | Meaning |
|---|---|
| 0 | All targeted users migrated successfully. |
| 1 | At least one user failed; source engine is retained. |
| 2 | Argument error (bad flags, missing `--from`/`--to`, unknown mode). |

Reads `./config.yaml` from the CWD (so the script assumes you ran it from the repo root). The CLI **does not** rewrite `storage.mode` in `config.yaml` — the operator must edit the file and restart the server to switch the running engine on a process that wasn't the one that ran the migration.

### Admin panel UI

`public/scripts/templates/admin.html` + `public/scripts/user.js`:

- "Storage Backend" tab in the admin panel.
- Shows current mode, the read-only flag, and the last-migration timestamp returned by `/api/users/storage/status`.
- Radio set covers all four engines (Filesystem / SQLite / MySQL / PostgreSQL). Selecting MySQL or PostgreSQL reveals an inline credential panel (URL + pool size). Leaving the URL blank falls back to `storage.mysql.url` / `storage.postgres.url` already set in `config.yaml`.
- Migration button is disabled for the radio matching the current mode (no self-migration). Live status and the per-user result map render into a `<pre>` block.
- After a successful migration the new `storage.mode` (plus any URL / poolSize the operator typed in) is written back to `config.yaml` via the comment-preserving `yaml.parseDocument` API. The same safety gate that `/config/save` uses (`validateConfigSafety`) runs first; if it refuses, the migration response carries `configPersisted: false` and the operator edits the file by hand.
- i18n: zh-cn + zh-tw + English (source).

### Backup convention

- Location: `<dataRoot>/_storage-migrations/<timestamp>-<handle>/`
- Format: verbatim recursive copy of the source user directory. For FS users this captures the JSONL/JSON tree; for SQLite users it captures the `.sqlite` file along with its `-wal` and `-shm` sidecars.
- **Never auto-deleted.** Operators clean up manually with `rm -rf`. The cost of disk usage is intentional — the backup is the only safety net if a migration produces wrong data on the destination and the operator doesn't notice until after re-saving.

### Migration semantics

- **Timestamps reset on migration.** FS uses `mtimeMs`; SQLite stores `Date.now()` at save. The destination's `updatedAt` will reflect "when migrated", not "when originally saved". `/api/chats/recent` ordering is scrambled until users save chats again.
- **Chat integrity slug rotates per engine.** The runner's verification strips integrity (both top-level and embedded in the header) before equality check. End users will see new integrity values after migration; OCC retries on the next save are normal.
- **`chat_size` in `/api/groups/all` is approximate in SQLite mode.** FS uses `fs.statSync().size`; SQLite uses `length(doc)` of the JSON string. Numbers differ; both are "rough size indicators" for the UI.
- **Preset state sidecars stay permissive on both engines** (no FK on `preset_states`). Migrating an orphan preset state (parent preset deleted but state file remained) copies as-is.

### Multi-process safety

The read-only flag lives in module-local state inside one Node process. If Luker is deployed as multiple Node processes behind a load balancer, the flag does **not** propagate between processes. Single-process Luker is the only supported deployment for migration; multi-process deployments must coordinate externally (admin downtime window) before triggering migration on one node.

### Recovery

If a migration fails mid-flight:

- The source engine remains active.
- The destination engine state may be partially written. Either:
  - Re-run the migration — it will overwrite the partial destination state, or
  - Manually delete the destination state (`rm <root>/luker-storage.sqlite*` for SQLite, or `rm -rf` the equivalent FS files for the affected handle) and re-run.

The backup at `<dataRoot>/_storage-migrations/<timestamp>-<handle>/` is the safety net. To restore a single user from backup:

```
rm -rf <dataRoot>/<handle>/
mv <dataRoot>/_storage-migrations/<timestamp>-<handle>/<handle>/ <dataRoot>/<handle>/
```

### Switching modes without migration

Switching `storage.mode` on a populated install **does not delete data** — the other engine's data files (the JSONL/JSON tree, or the `luker-storage.sqlite` file) are left untouched. However, the running engine only sees its own backing store, so the other engine's data becomes **invisible** until you switch back. For first installs or empty users, switching is safe.

## Where user data lives

In db modes (sqlite / mysql / postgres), the resources below live in the engine. In fs mode, the same resources live on disk under `<dataRoot>/<handle>/` per the per-Repo paths in the "Repos shipped" table above.

| Resource | Engine tables (mysql / pg / sqlite) | On disk (every mode) |
|---|---|---|
| Chat content (header + messages) | `chats` | — |
| Per-chat sidecar state (plugin namespaces) | `chat_states` | — |
| User settings (UI prefs, persona, etc.) | `settings` | — |
| Presets (Kobold/OpenAI/NovelAI/textgen, instruct, context, sysprompt, reasoning) | `presets` | — |
| Per-preset sidecar state | `preset_states` | — |
| World info books | `worlds` | — |
| Named docs (themes, moving UI, quick replies) | `named_docs` | — |
| Group definitions | `groups_table` | — |
| User-level chat stats | `stats` | — |
| Character cards (PNG with embedded JSON) | — | `<root>/<handle>/characters/*.png` |
| User avatars | — | `<root>/<handle>/User Avatars/*.png` |
| Backgrounds | — | `<root>/<handle>/backgrounds/*` |
| User-uploaded files / images / workflows | — | `<root>/<handle>/user/{files,images,workflows}/` |
| Character emotion sprites | — | `<root>/<handle>/characters/<name>/*.png` |
| Plugin/extension trees | — | `<root>/<handle>/extensions/` |
| Vector index databases | — | `<root>/<handle>/vectors/` |
| Login secrets | — | `<root>/<handle>/secrets.json` |
| Settings snapshots | — | `<root>/<handle>/backups/settings_*.json` |
| Chat backups (incremental snapshots) | — | `<root>/<handle>/backups/chat_*.jsonl` |

### Why some resources stay on disk

- **Binary blobs** (character cards, avatars, backgrounds, sprites, user uploads): a `BLOB` column is awkward to stream, expensive to seek, and a poor fit for the SQL drivers' default fetch semantics. Filesystem reads handle these efficiently.
- **Git-cloned trees** (extensions): the plugin lifecycle expects directory semantics (subdirectories, recursive reads). Storing as engine rows would require re-implementing tree traversal.
- **Third-party formats** (vectors): vector databases have their own on-disk format that the engine layer can't usefully wrap.
- **Single-file scoped artifacts** (secrets, settings snapshots, chat backups): live on disk because their lifecycle (rotation, backup, admin-visible) is naturally per-file, and they don't benefit from cross-user querying.

A backup ZIP in db mode includes `_engine_dump.bin` + `_engine_meta.json` for the engine rows, plus the on-disk files above. A restore in matching engine kind round-trips both halves. Cross-engine restore must go through `scripts/storage-migrate.js` first to convert.
