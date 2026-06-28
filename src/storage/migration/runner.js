import { setReadOnly, withReadOnlyBypass } from '../read-only-mode.js';
import { PRESET_FOLDER_BY_API_ID } from '../repositories/preset-repo.js';
import { BUCKET_TO_DIR } from '../repositories/named-doc-repo.js';
import { snapshotUser, restoreFromSnapshot, removeSnapshot } from './backup.js';
import { recordsEqual } from './equality.js';

// Canonical category shape — every section the runner can copy. Callers
// supplying `categories` opt in/out of sections via this set of keys; unknown
// keys are silently dropped (see constructor). Exported as
// DEFAULT_MIGRATION_CATEGORIES so cross-mode-restore can reference the same
// shape when translating UI selections into runner-level toggles.
const DEFAULT_CATEGORIES = Object.freeze({
    settings: true,
    presets: true,
    namedDocs: true,
    worlds: true,
    chats: true,
    groups: true,
    stats: true,
});

export const DEFAULT_MIGRATION_CATEGORIES = DEFAULT_CATEGORIES;

// Subset of the per-user stats accumulator that callers care about for
// in-flight progress. `errors` / `backupPath` / `verified` are only meaningful
// at the end of migrateUser, so they're excluded.
function snapshotCounts(stats) {
    return {
        settings: stats.settings,
        presets: stats.presets,
        preset_states: stats.preset_states,
        worlds: stats.worlds,
        chats: stats.chats,
        chat_states: stats.chat_states,
        named_docs: stats.named_docs,
        groups: stats.groups,
        stats: stats.stats,
    };
}

/**
 * @typedef {object} RepoSet
 * @property {object} chat
 * @property {object} settings
 * @property {object} preset
 * @property {object} worldInfo
 * @property {object} namedDoc
 * @property {object} group
 * @property {object} stats
 */

/**
 * MigrationRunner copies a user's entire per-handle payload from one Engine
 * (via `sourceRepos`) to another (via `destRepos`), verifying each record
 * INLINE — after every per-record destination write the runner re-reads the
 * dest and compares with `recordsEqual` (which tolerates the engine-rotated
 * integrity / timestamp fields on chat records). The first divergence aborts
 * the copy loop with `<kind> verify mismatch for <key>` so the failed key is
 * named explicitly (spec §4.3 "first divergent key", no full-record dump).
 *
 * Inline verification replaces the legacy two-pass model (copy-all then a
 * standalone verify pass over an in-memory `sourceData` accumulator). The
 * memory footprint is now ~1 record per kind in scope at any time, which
 * makes the runner usable for users with tens of GB of chats.
 *
 * Before any destination writes happen, a permanent on-disk backup of the
 * source user's data directory is taken — and, when `sourceEngine` is passed
 * AND it isn't fs-kind, an engine-side dump is captured alongside the fs tree
 * (spec §4.4: mysql/pg rows don't live in the user dir, so cpSync alone would
 * miss them on rollback). On any post-snapshot failure the runner restores
 * the source from that backup automatically (`_rollback`).
 *
 * The runner is constructor-injected with already-built per-engine Repo sets
 * so test harnesses (and the eventual CLI/admin endpoint) can decide how to
 * wire engines.
 *
 * Each preset apiId is mapped to its on-disk dirKey via PRESET_FOLDER_BY_API_ID.
 * Some apiIds share a dirKey (kobold + koboldhorde → koboldAI_Settings); the
 * runner iterates dirKeys (deduped) and picks one representative apiId per
 * dirKey to drive PresetRepo.list / .save calls. Reading + writing the same
 * dirKey via both apiIds would double-count the same files.
 */
export class MigrationRunner {
    /**
     * @param {object} opts
     * @param {RepoSet} opts.sourceRepos
     * @param {RepoSet} opts.destRepos
     * @param {{ dataRoot?: string, backupRoot: string, getUserRoot: (handle: string) => string }} opts.snapshotPaths
     * @param {object|null} [opts.sourceEngine] — engine driving sourceRepos. When
     *     present and not fs-kind, the per-user snapshot also captures an
     *     engine-side dump (and the rollback replays it). Optional — fs↔fs and
     *     fs↔sqlite paths where the engine state lives inside userRoot work
     *     without it. The auto-rollback test deliberately omits it; the
     *     migration suite's fs↔sqlite tests do the same.
     * @param {boolean} [opts.dryRun=false]
     * @param {boolean} [opts.keepSnapshot=false] — when false (default) a
     *     successful migrateUser deletes the per-user snapshot dir created at
     *     step 1 (spec §4.4 finally clause). Set true to keep the snapshot
     *     around — useful for admins who want a manual restore point after a
     *     known-good migration, or for forensic comparison of source vs dest
     *     after the fact. Failed migrations always preserve their snapshot
     *     regardless of this flag, so a rollback can always be redone manually.
     */
    constructor({ sourceRepos, sourceEngine = null, destRepos, snapshotPaths, dryRun = false, keepSnapshot = false, categories = null, skipInternalSnapshot = false }) {
        if (!sourceRepos) throw new Error('MigrationRunner: sourceRepos required');
        if (!destRepos) throw new Error('MigrationRunner: destRepos required');
        if (!snapshotPaths || typeof snapshotPaths.getUserRoot !== 'function') {
            throw new Error('MigrationRunner: snapshotPaths.getUserRoot required');
        }
        if (!snapshotPaths.backupRoot) {
            throw new Error('MigrationRunner: snapshotPaths.backupRoot required');
        }
        this._src = sourceRepos;
        this._srcEngine = sourceEngine;
        this._dst = destRepos;
        this._snapshotPaths = snapshotPaths;
        this._dryRun = !!dryRun;
        this._keepSnapshot = !!keepSnapshot;
        // When true, migrateUser skips its internal source-side snapshot AND
        // the corresponding _rollback. Used by the cross-mode restore
        // orchestrator: it takes its OWN snapshot of the live destination
        // (which is what needs protecting; source is a throwaway scratch
        // engine) and handles rollback itself. Without this flag the runner
        // would also snapshot the scratch source dir — wasted disk + time
        // since the scratch is rm'd on cleanup anyway.
        this._skipInternalSnapshot = !!skipInternalSnapshot;
        // Merge caller-supplied categories on top of all-true defaults. Unknown
        // keys are silently dropped (defensive against typos that would
        // otherwise enable a non-existent section). Missing keys keep default
        // (true), so `{ chats: true }` does NOT mean "chats only" — that's a
        // surprising API. Callers wanting "chats only" must pass an explicit
        // all-false-then-chats-true object. See cross-mode-restore for the
        // pattern (selectionToRunnerCategories returns a full 7-key shape).
        this._categories = { ...DEFAULT_CATEGORIES };
        if (categories) {
            for (const key of Object.keys(DEFAULT_CATEGORIES)) {
                if (Object.prototype.hasOwnProperty.call(categories, key)) {
                    this._categories[key] = !!categories[key];
                }
            }
        }
    }

    /**
     * Copy + verify one user. Throws on first error (after recording it in
     * `stats.errors`). Caller is responsible for setReadOnly() — migrateAllUsers
     * does it; if you call migrateUser solo, do it yourself.
     *
     * Verification happens INLINE inside `_copyAll` (each dest write is
     * immediately read back and compared with the source record). The
     * `verifying` / `verified` progress markers are still emitted post-copy as
     * terminal signals so existing progress consumers don't need to change.
     *
     * `destHandle` defaults to `srcHandle` (back-compat for every existing
     * caller — admin `/storage/migrate`, CLI `storage-migrate`, tests). Cross-
     * mode-restore passes a distinct dst handle so a scratch
     * source like `_xrestore_xxx` can be copied INTO a real user handle. The
     * snapshot + rollback path stays bound to `srcHandle` regardless — the
     * runner snapshots and (on failure) restores the SOURCE side; the dst is
     * just a write target.
     *
     * `stats.handle` keeps `srcHandle` so existing progress consumers see the
     * same identifier they saw before — they don't care about destHandle (it's
     * an orchestrator concern); cross-mode callers will observe the
     * scratch source handle, which is correct because the runner is operating
     * ON the source.
     */
    async migrateUser(srcHandle, { onProgress = () => {}, destHandle = null } = {}) {
        const effectiveDestHandle = destHandle != null ? destHandle : srcHandle;
        const stats = {
            handle: srcHandle,
            settings: 0,
            presets: 0,
            preset_states: 0,
            worlds: 0,
            chats: 0,
            chat_states: 0,
            named_docs: 0,
            groups: 0,
            stats: 0,
            backupPath: null,
            errors: [],
            verified: false,
        };

        // 1. Snapshot the source state first (skipped on dry-run AND when
        //    skipInternalSnapshot is set — cross-mode-restore passes the
        //    latter because the orchestrator has already snapshotted the
        //    live destination, and the runner's source side is a throwaway
        //    scratch dir that doesn't need protection).
        if (!this._dryRun && !this._skipInternalSnapshot) {
            try {
                stats.backupPath = await snapshotUser({
                    handle: srcHandle,
                    userRoot: this._snapshotPaths.getUserRoot(srcHandle),
                    backupRoot: this._snapshotPaths.backupRoot,
                    engine: this._srcEngine,
                });
                onProgress({ stage: 'snapshotted', handle: srcHandle, backupPath: stats.backupPath, counts: snapshotCounts(stats) });
            } catch (err) {
                stats.errors.push({ stage: 'snapshot', message: err.message });
                throw new Error(`migration failed at snapshot for ${srcHandle}: ${err.message}`);
            }
        }

        // 2. Copy + inline-verify in one pass, with snapshot GC tied to
        //    success via the outer finally. Any post-snapshot failure leaves
        //    the snapshot on disk for forensic inspection (spec §4.4: "if
        //    success and !keepSnapshot: removeSnapshot(snapshot)"). The inner
        //    catch around _copyAll still fires _rollback before re-throwing —
        //    that path uses stats.backupPath, which is why GC has to wait
        //    until everything else has settled.
        try {
            // The per-record verify lives inside _copyAll; any mismatch
            // surfaces as `<kind> verify mismatch for <key>`, gets caught
            // here, recorded as a copy-stage failure (rollback fires the
            // same way for write failures and verify failures), and re-
            // thrown wrapped.
            try {
                await withReadOnlyBypass(() => this._copyAll(srcHandle, effectiveDestHandle, stats, onProgress));
            } catch (err) {
                stats.errors.push({ stage: 'copy', message: err.message });
                await this._rollback(srcHandle, stats);
                throw new Error(`migration failed during copy for ${srcHandle}: ${err.message}`);
            }

            // 3. Verification already happened per-record during copy. On
            //    non-dry runs we still emit `verifying`/`verified` as terminal
            //    markers (with the total record count) so existing
            //    onProgress consumers keep working without a contract change.
            if (!this._dryRun) {
                const totalRecords = stats.settings
                    + stats.presets + stats.preset_states
                    + stats.worlds
                    + stats.chats + stats.chat_states
                    + stats.named_docs
                    + stats.groups
                    + stats.stats;
                onProgress({ stage: 'verifying', handle: srcHandle, totalRecords, counts: snapshotCounts(stats) });
                stats.verified = true;
                onProgress({ stage: 'verified', handle: srcHandle, totalRecords, counts: snapshotCounts(stats) });
            }

            onProgress({ stage: 'done', handle: srcHandle, stats, counts: snapshotCounts(stats) });
            return stats;
        } finally {
            // GC the snapshot ONLY on a clean run. `stats.errors.length === 0`
            // covers both copy failures (pushed { stage: 'copy', ... }) and
            // rollback markers (pushed by `_rollback`), so any failed
            // migration keeps the snapshot for forensics — exactly as the
            // brief promises. Dry-run never took a snapshot so backupPath
            // stays null and the guard is a no-op.
            if (!this._keepSnapshot && stats.backupPath && stats.errors.length === 0) {
                removeSnapshot(stats.backupPath);
                stats.backupPath = null;
            }
        }
    }

    /**
     * Auto-rollback per spec §4.4: on any post-snapshot failure, restore the
     * user's on-disk dir from the snapshot taken at the start of migrateUser.
     * Pushes a marker entry into `stats.errors` so callers can see rollback
     * was attempted. Failures inside rollback itself are also recorded but
     * never thrown — the outer code is already re-throwing the original cause.
     *
     * In db-mode runs (sourceEngine && kind !== 'fs') restoreFromSnapshot also
     * replays the captured `_engine_dump.bin` through `engine.restoreUser` so
     * mysql/pg rows mutated during the failed copy are reverted to the
     * pre-migration state — fs-only restore would leave the engine state
     * stuck in whatever half-state the failure produced.
     *
     * No-op on dry-run (no snapshot was taken).
     */
    async _rollback(handle, stats) {
        if (this._dryRun || !stats.backupPath) return;
        try {
            await restoreFromSnapshot({
                handle,
                userRoot: this._snapshotPaths.getUserRoot(handle),
                backupPath: stats.backupPath,
                engine: this._srcEngine,
            });
            stats.errors.push({ stage: 'rollback', message: 'restored from snapshot', rolledBack: true });
        } catch (rollbackErr) {
            stats.errors.push({ stage: 'rollback', message: rollbackErr.message, rolledBack: false });
        }
    }

    /**
     * Migrate multiple users sequentially. Flips READ_ONLY around the whole
     * batch so the source surface is frozen for callers. Per-user failures are
     * captured into the result object rather than aborting the batch; READ_ONLY
     * is always restored via finally.
     */
    async migrateAllUsers(handles, { onProgress = () => {} } = {}) {
        const results = {};
        setReadOnly(true);
        try {
            for (const handle of handles) {
                try {
                    results[handle] = await this.migrateUser(handle, { onProgress });
                } catch (err) {
                    results[handle] = {
                        handle,
                        error: err.message,
                        verified: false,
                    };
                    onProgress({ stage: 'user-failed', handle, error: err.message });
                }
            }
        } finally {
            setReadOnly(false);
        }
        return results;
    }

    // --------------------------------------------------------------------
    // Internal helpers
    // --------------------------------------------------------------------

    async _copyAll(srcHandle, dstHandle, stats, onProgress) {
        // Settings
        if (this._categories.settings) {
            const settings = await this._src.settings.get(srcHandle);
            if (settings != null) {
                if (!this._dryRun) {
                    await this._dst.settings.save(dstHandle, settings);
                    const dstSettings = await this._dst.settings.get(dstHandle);
                    if (!recordsEqual('settings', settings, dstSettings)) {
                        throw new Error('settings verify mismatch');
                    }
                }
                stats.settings = 1;
            }
            onProgress({ stage: 'settings-copied', handle: srcHandle, counts: snapshotCounts(stats) });
        }

        // Presets — iterate unique dirKeys; each dirKey may map from multiple
        // apiIds (kobold + koboldhorde share koboldAI_Settings). Use a Map from
        // dirKey to the first apiId encountered for that dirKey.
        // Also skip preset_states when presets is off (states are meaningless
        // without their parent preset).
        if (this._categories.presets) {
            const dirKeyToApiId = new Map();
            for (const [apiId, dirKey] of Object.entries(PRESET_FOLDER_BY_API_ID)) {
                if (!dirKeyToApiId.has(dirKey)) dirKeyToApiId.set(dirKey, apiId);
            }
            for (const apiId of dirKeyToApiId.values()) {
                const presetList = await this._src.preset.list(srcHandle, apiId);
                for (const item of presetList) {
                    const name = item.key.name;
                    const doc = await this._src.preset.get(srcHandle, apiId, name);
                    if (doc == null) continue;
                    if (!this._dryRun) {
                        await this._dst.preset.save(dstHandle, apiId, name, doc);
                        const dstDoc = await this._dst.preset.get(dstHandle, apiId, name);
                        if (!recordsEqual('preset', doc, dstDoc)) {
                            throw new Error(`preset verify mismatch for ${apiId}/${name}`);
                        }
                    }
                    stats.presets++;
                    const namespaces = await this._src.preset.listStateNamespaces(srcHandle, apiId, name);
                    for (const ns of namespaces) {
                        const stateDoc = await this._src.preset.getState(srcHandle, apiId, name, ns);
                        if (stateDoc == null) continue;
                        if (!this._dryRun) {
                            await this._dst.preset.setState(dstHandle, apiId, name, ns, stateDoc);
                            const dstState = await this._dst.preset.getState(dstHandle, apiId, name, ns);
                            if (!recordsEqual('preset-state', stateDoc, dstState)) {
                                throw new Error(`preset state verify mismatch for ${apiId}/${name}/${ns}`);
                            }
                        }
                        stats.preset_states++;
                    }
                }
            }
            onProgress({ stage: 'presets-copied', handle: srcHandle, counts: snapshotCounts(stats) });
        }

        // Worlds
        if (this._categories.worlds) {
            const worldList = await this._src.worldInfo.list(srcHandle);
            for (const item of worldList) {
                const name = item.key.name;
                const doc = await this._src.worldInfo.get(srcHandle, name);
                if (doc == null) continue;
                if (!this._dryRun) {
                    await this._dst.worldInfo.save(dstHandle, name, doc);
                    const dstDoc = await this._dst.worldInfo.get(dstHandle, name);
                    if (!recordsEqual('world', doc, dstDoc)) {
                        throw new Error(`world verify mismatch for ${name}`);
                    }
                }
                stats.worlds++;
            }
            onProgress({ stage: 'worlds-copied', handle: srcHandle, counts: snapshotCounts(stats) });
        }

        // Chats — split into "per-character" and "group" tracks because the FS
        // engine's chat list only walks `chats/<charDir>/*.jsonl` and never the
        // `group chats/` directory, while the SQLite engine returns ALL rows
        // (including group ones). To normalize:
        //   - Per-character: take whatever listRecent returns, but skip rows
        //     where key.isGroup is true (a SQLite-only situation; FS already
        //     filters this naturally).
        //   - Group chats: enumerate via the source's group docs (each group's
        //     `chats` array names its member chat ids) — same source-of-truth
        //     for both engines.
        // Group chats are also gated by `chats` (group chats are chats).
        if (this._categories.chats) {
            const allListed = await this._src.chat.listRecent(srcHandle, { limit: 1_000_000 });
            const perCharList = allListed.filter((item) => !item.key.isGroup);
            for (const item of perCharList) {
                const key = item.key;
                const chat = await this._src.chat.get(srcHandle, key.charDir, key.name);
                if (chat == null) continue;
                if (!this._dryRun) {
                    // Use saveRaw to preserve the source's integrity, createdAt,
                    // and updatedAt — ChatRepo.save() would rotate integrity to a
                    // new UUID and stamp updatedAt = now, which silently breaks
                    // any client caching the old integrity and reorders the
                    // recency index after migration.
                    await this._dst.chat.saveRaw(
                        dstHandle, key.charDir, key.name,
                        {
                            header: chat.header,
                            body: chat.body,
                            integrity: chat.integrity,
                            updatedAt: chat.updatedAt,
                            createdAt: chat.createdAt,
                        },
                    );
                    const dstChat = await this._dst.chat.get(dstHandle, key.charDir, key.name);
                    if (!recordsEqual('chat', chat, dstChat)) {
                        throw new Error(`chat verify mismatch for ${key.charDir || '(group)'}::${key.name}`);
                    }
                    if (dstChat?.integrity !== chat.integrity) {
                        throw new Error(`chat integrity drift for ${key.charDir || '(group)'}::${key.name}`);
                    }
                }
                stats.chats++;
                const namespaces = await this._src.chat.listStateNamespaces(srcHandle, key.charDir, key.name);
                for (const ns of namespaces) {
                    const stateDoc = await this._src.chat.getState(srcHandle, key.charDir, key.name, ns);
                    if (stateDoc == null) continue;
                    if (!this._dryRun) {
                        await this._dst.chat.setState(dstHandle, key.charDir, key.name, ns, stateDoc);
                        const dstState = await this._dst.chat.getState(dstHandle, key.charDir, key.name, ns);
                        if (!recordsEqual('chat-state', stateDoc, dstState)) {
                            throw new Error(
                                `chat state verify mismatch for ${key.charDir || '(group)'}::${key.name}::${ns}`,
                            );
                        }
                    }
                    stats.chat_states++;
                }
            }
            // Group chats — enumerate via group docs, then read each group chat.
            const groupListForChats = await this._src.group.list(srcHandle);
            for (const groupItem of groupListForChats) {
                const groupDoc = await this._src.group.get(srcHandle, groupItem.key.id);
                if (groupDoc == null || !Array.isArray(groupDoc.chats)) continue;
                for (const chatId of groupDoc.chats) {
                    const chat = await this._src.chat.get(
                        srcHandle, null, chatId,
                        { isGroup: true, groupId: chatId },
                    );
                    if (chat == null) continue;
                    if (!this._dryRun) {
                        await this._dst.chat.saveRaw(
                            dstHandle, null, chatId,
                            {
                                header: chat.header,
                                body: chat.body,
                                integrity: chat.integrity,
                                updatedAt: chat.updatedAt,
                                createdAt: chat.createdAt,
                            },
                            { isGroup: true, groupId: chatId },
                        );
                        const dstChat = await this._dst.chat.get(
                            dstHandle, null, chatId,
                            { isGroup: true, groupId: chatId },
                        );
                        if (!recordsEqual('chat', chat, dstChat)) {
                            throw new Error(`chat verify mismatch for (group)::${chatId} (groupId=${chatId})`);
                        }
                        if (dstChat?.integrity !== chat.integrity) {
                            throw new Error(`chat integrity drift for (group)::${chatId} (groupId=${chatId})`);
                        }
                    }
                    stats.chats++;
                    const namespaces = await this._src.chat.listStateNamespaces(
                        srcHandle, null, chatId, { isGroup: true, groupId: chatId },
                    );
                    for (const ns of namespaces) {
                        const stateDoc = await this._src.chat.getState(
                            srcHandle, null, chatId, ns,
                            { isGroup: true, groupId: chatId },
                        );
                        if (stateDoc == null) continue;
                        if (!this._dryRun) {
                            await this._dst.chat.setState(
                                dstHandle, null, chatId, ns, stateDoc,
                                { isGroup: true, groupId: chatId },
                            );
                            const dstState = await this._dst.chat.getState(
                                dstHandle, null, chatId, ns,
                                { isGroup: true, groupId: chatId },
                            );
                            if (!recordsEqual('chat-state', stateDoc, dstState)) {
                                throw new Error(`chat state verify mismatch for (group)::${chatId}::${ns}`);
                            }
                        }
                        stats.chat_states++;
                    }
                }
            }
            onProgress({ stage: 'chats-copied', handle: srcHandle, counts: snapshotCounts(stats) });
        }

        // Named-docs — iterate all known buckets.
        if (this._categories.namedDocs) {
            for (const bucket of Object.keys(BUCKET_TO_DIR)) {
                const list = await this._src.namedDoc.list(srcHandle, bucket);
                for (const item of list) {
                    const name = item.key.name;
                    const doc = await this._src.namedDoc.get(srcHandle, bucket, name);
                    if (doc == null) continue;
                    if (!this._dryRun) {
                        await this._dst.namedDoc.save(dstHandle, bucket, name, doc);
                        const dstDoc = await this._dst.namedDoc.get(dstHandle, bucket, name);
                        if (!recordsEqual('named-doc', doc, dstDoc)) {
                            throw new Error(`named-doc verify mismatch for ${bucket}/${name}`);
                        }
                    }
                    stats.named_docs++;
                }
            }
            onProgress({ stage: 'named-docs-copied', handle: srcHandle, counts: snapshotCounts(stats) });
        }

        // Groups (the group docs themselves, not the chats inside them)
        if (this._categories.groups) {
            const groupList = await this._src.group.list(srcHandle);
            for (const item of groupList) {
                const id = item.key.id;
                const doc = await this._src.group.get(srcHandle, id);
                if (doc == null) continue;
                if (!this._dryRun) {
                    await this._dst.group.save(dstHandle, id, doc);
                    const dstDoc = await this._dst.group.get(dstHandle, id);
                    if (!recordsEqual('group', doc, dstDoc)) {
                        throw new Error(`group verify mismatch for ${id}`);
                    }
                }
                stats.groups++;
            }
            onProgress({ stage: 'groups-copied', handle: srcHandle, counts: snapshotCounts(stats) });
        }

        // Stats
        if (this._categories.stats) {
            const statsDoc = await this._src.stats.get(srcHandle);
            if (statsDoc != null) {
                if (!this._dryRun) {
                    await this._dst.stats.save(dstHandle, statsDoc);
                    const dstStats = await this._dst.stats.get(dstHandle);
                    if (!recordsEqual('stats', statsDoc, dstStats)) {
                        throw new Error('stats verify mismatch');
                    }
                }
                stats.stats = 1;
            }
            onProgress({ stage: 'stats-copied', handle: srcHandle, counts: snapshotCounts(stats) });
        }
    }
}
