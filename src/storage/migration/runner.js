import { setReadOnly, withReadOnlyBypass } from '../read-only-mode.js';
import { PRESET_FOLDER_BY_API_ID } from '../repositories/preset-repo.js';
import { BUCKET_TO_DIR } from '../repositories/named-doc-repo.js';
import { snapshotUser } from './backup.js';
import { recordsEqual } from './equality.js';

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
 * (via `sourceRepos`) to another (via `destRepos`), then verifies by reading
 * the destination back and comparing with `recordsEqual` (which tolerates the
 * engine-rotated integrity / timestamp fields on chat records).
 *
 * Before any destination writes happen, a permanent on-disk backup of the
 * source user's data directory is taken. If anything blows up — or the
 * verification step trips — the operator restores by removing the new dest
 * data and copying the backup back in place; no in-runner rollback is
 * attempted because the migration is meant to be done with the source frozen
 * via setReadOnly(), so there is nothing on the source to roll back.
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
     * @param {boolean} [opts.dryRun=false]
     */
    constructor({ sourceRepos, destRepos, snapshotPaths, dryRun = false }) {
        if (!sourceRepos) throw new Error('MigrationRunner: sourceRepos required');
        if (!destRepos) throw new Error('MigrationRunner: destRepos required');
        if (!snapshotPaths || typeof snapshotPaths.getUserRoot !== 'function') {
            throw new Error('MigrationRunner: snapshotPaths.getUserRoot required');
        }
        if (!snapshotPaths.backupRoot) {
            throw new Error('MigrationRunner: snapshotPaths.backupRoot required');
        }
        this._src = sourceRepos;
        this._dst = destRepos;
        this._snapshotPaths = snapshotPaths;
        this._dryRun = !!dryRun;
    }

    /**
     * Copy + verify one user. Throws on first error (after recording it in
     * `stats.errors`). Caller is responsible for setReadOnly() — migrateAllUsers
     * does it; if you call migrateUser solo, do it yourself.
     */
    async migrateUser(handle, { onProgress = () => {} } = {}) {
        const stats = {
            handle,
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

        // 1. Snapshot the source state first (skipped on dry-run).
        if (!this._dryRun) {
            try {
                stats.backupPath = snapshotUser({
                    handle,
                    userRoot: this._snapshotPaths.getUserRoot(handle),
                    backupRoot: this._snapshotPaths.backupRoot,
                });
                onProgress({ stage: 'snapshotted', handle, backupPath: stats.backupPath });
            } catch (err) {
                stats.errors.push({ stage: 'snapshot', message: err.message });
                throw new Error(`migration failed at snapshot for ${handle}: ${err.message}`);
            }
        }

        // 2. Read each kind off source, write to dest, accumulate sourceData for verify.
        const sourceData = {
            settings: null,
            presets: [],         // [{ apiId, name, doc }]
            presetStates: [],    // [{ apiId, name, namespace, doc }]
            worlds: [],          // [{ name, doc }]
            chats: [],           // [{ key, record }] — key carries charDir/name/isGroup/groupId
            chatStates: [],      // [{ key, namespace, doc }]
            namedDocs: [],       // [{ bucket, name, doc }]
            groups: [],          // [{ id, doc }]
            stats: null,
        };

        try {
            // Wrap copy in a bypass scope so destination writes work even if
            // the caller has flipped READ_ONLY to freeze the source's HTTP
            // surface (migrateAllUsers does exactly that).
            await withReadOnlyBypass(() => this._copyAll(handle, sourceData, stats, onProgress));
        } catch (err) {
            stats.errors.push({ stage: 'copy', message: err.message });
            throw new Error(`migration failed during copy for ${handle}: ${err.message}`);
        }

        // 3. Verify (skipped on dry-run since nothing was written).
        if (!this._dryRun) {
            onProgress({ stage: 'verifying', handle });
            try {
                await this._verify(handle, sourceData);
                stats.verified = true;
                onProgress({ stage: 'verified', handle });
            } catch (err) {
                stats.errors.push({ stage: 'verify', message: err.message });
                throw new Error(`migration verification failed for ${handle}: ${err.message}`);
            }
        }

        onProgress({ stage: 'done', handle, stats });
        return stats;
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

    async _copyAll(handle, sourceData, stats, onProgress) {
        // Settings
        const settings = await this._src.settings.get(handle);
        if (settings != null) {
            sourceData.settings = settings;
            if (!this._dryRun) await this._dst.settings.save(handle, settings);
            stats.settings = 1;
        }
        onProgress({ stage: 'settings-copied', handle });

        // Presets — iterate unique dirKeys; each dirKey may map from multiple
        // apiIds (kobold + koboldhorde share koboldAI_Settings). Use a Map from
        // dirKey to the first apiId encountered for that dirKey.
        const dirKeyToApiId = new Map();
        for (const [apiId, dirKey] of Object.entries(PRESET_FOLDER_BY_API_ID)) {
            if (!dirKeyToApiId.has(dirKey)) dirKeyToApiId.set(dirKey, apiId);
        }
        for (const apiId of dirKeyToApiId.values()) {
            const presetList = await this._src.preset.list(handle, apiId);
            for (const item of presetList) {
                const name = item.key.name;
                const doc = await this._src.preset.get(handle, apiId, name);
                if (doc == null) continue;
                sourceData.presets.push({ apiId, name, doc });
                if (!this._dryRun) await this._dst.preset.save(handle, apiId, name, doc);
                stats.presets++;
                const namespaces = await this._src.preset.listStateNamespaces(handle, apiId, name);
                for (const ns of namespaces) {
                    const stateDoc = await this._src.preset.getState(handle, apiId, name, ns);
                    if (stateDoc == null) continue;
                    sourceData.presetStates.push({ apiId, name, namespace: ns, doc: stateDoc });
                    if (!this._dryRun) await this._dst.preset.setState(handle, apiId, name, ns, stateDoc);
                    stats.preset_states++;
                }
            }
        }
        onProgress({ stage: 'presets-copied', handle });

        // Worlds
        const worldList = await this._src.worldInfo.list(handle);
        for (const item of worldList) {
            const name = item.key.name;
            const doc = await this._src.worldInfo.get(handle, name);
            if (doc == null) continue;
            sourceData.worlds.push({ name, doc });
            if (!this._dryRun) await this._dst.worldInfo.save(handle, name, doc);
            stats.worlds++;
        }
        onProgress({ stage: 'worlds-copied', handle });

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
        const allListed = await this._src.chat.listRecent(handle, { limit: 1_000_000 });
        const perCharList = allListed.filter((item) => !item.key.isGroup);
        for (const item of perCharList) {
            const key = item.key;
            const chat = await this._src.chat.get(handle, key.charDir, key.name);
            if (chat == null) continue;
            sourceData.chats.push({ key: { ...key, isGroup: false, groupId: undefined }, record: chat });
            if (!this._dryRun) {
                // ChatRepo.save rotates integrity on the dest — that's the
                // whole point of the verify step using stripChatEngineMeta.
                await this._dst.chat.save(
                    handle, key.charDir, key.name,
                    chat.header, chat.body, null,
                );
            }
            stats.chats++;
            const namespaces = await this._src.chat.listStateNamespaces(handle, key.charDir, key.name);
            for (const ns of namespaces) {
                const stateDoc = await this._src.chat.getState(handle, key.charDir, key.name, ns);
                if (stateDoc == null) continue;
                sourceData.chatStates.push({
                    key: { ...key, isGroup: false, groupId: undefined },
                    namespace: ns, doc: stateDoc,
                });
                if (!this._dryRun) {
                    await this._dst.chat.setState(handle, key.charDir, key.name, ns, stateDoc);
                }
                stats.chat_states++;
            }
        }
        // Group chats — enumerate via group docs, then read each group chat.
        const groupListForChats = await this._src.group.list(handle);
        for (const groupItem of groupListForChats) {
            const groupDoc = await this._src.group.get(handle, groupItem.key.id);
            if (groupDoc == null || !Array.isArray(groupDoc.chats)) continue;
            for (const chatId of groupDoc.chats) {
                const chat = await this._src.chat.get(
                    handle, null, chatId,
                    { isGroup: true, groupId: chatId },
                );
                if (chat == null) continue;
                const key = { kind: 'chat', handle, charDir: undefined, name: chatId, isGroup: true, groupId: chatId };
                sourceData.chats.push({ key, record: chat });
                if (!this._dryRun) {
                    await this._dst.chat.save(
                        handle, null, chatId,
                        chat.header, chat.body, null,
                        { isGroup: true, groupId: chatId },
                    );
                }
                stats.chats++;
                const namespaces = await this._src.chat.listStateNamespaces(
                    handle, null, chatId, { isGroup: true, groupId: chatId },
                );
                for (const ns of namespaces) {
                    const stateDoc = await this._src.chat.getState(
                        handle, null, chatId, ns,
                        { isGroup: true, groupId: chatId },
                    );
                    if (stateDoc == null) continue;
                    sourceData.chatStates.push({ key, namespace: ns, doc: stateDoc });
                    if (!this._dryRun) {
                        await this._dst.chat.setState(
                            handle, null, chatId, ns, stateDoc,
                            { isGroup: true, groupId: chatId },
                        );
                    }
                    stats.chat_states++;
                }
            }
        }
        onProgress({ stage: 'chats-copied', handle });

        // Named-docs — iterate all known buckets.
        for (const bucket of Object.keys(BUCKET_TO_DIR)) {
            const list = await this._src.namedDoc.list(handle, bucket);
            for (const item of list) {
                const name = item.key.name;
                const doc = await this._src.namedDoc.get(handle, bucket, name);
                if (doc == null) continue;
                sourceData.namedDocs.push({ bucket, name, doc });
                if (!this._dryRun) await this._dst.namedDoc.save(handle, bucket, name, doc);
                stats.named_docs++;
            }
        }
        onProgress({ stage: 'named-docs-copied', handle });

        // Groups
        const groupList = await this._src.group.list(handle);
        for (const item of groupList) {
            const id = item.key.id;
            const doc = await this._src.group.get(handle, id);
            if (doc == null) continue;
            sourceData.groups.push({ id, doc });
            if (!this._dryRun) await this._dst.group.save(handle, id, doc);
            stats.groups++;
        }
        onProgress({ stage: 'groups-copied', handle });

        // Stats
        const statsDoc = await this._src.stats.get(handle);
        if (statsDoc != null) {
            sourceData.stats = statsDoc;
            if (!this._dryRun) await this._dst.stats.save(handle, statsDoc);
            stats.stats = 1;
        }
        onProgress({ stage: 'stats-copied', handle });
    }

    async _verify(handle, sourceData) {
        if (sourceData.settings != null) {
            const dst = await this._dst.settings.get(handle);
            if (!recordsEqual('settings', sourceData.settings, dst)) {
                throw new Error('settings verify mismatch');
            }
        }
        for (const { apiId, name, doc } of sourceData.presets) {
            const dst = await this._dst.preset.get(handle, apiId, name);
            if (!recordsEqual('preset', doc, dst)) {
                throw new Error(`preset verify mismatch for ${apiId}/${name}`);
            }
        }
        for (const { apiId, name, namespace, doc } of sourceData.presetStates) {
            const dst = await this._dst.preset.getState(handle, apiId, name, namespace);
            if (!recordsEqual('preset-state', doc, dst)) {
                throw new Error(`preset state verify mismatch for ${apiId}/${name}/${namespace}`);
            }
        }
        for (const { name, doc } of sourceData.worlds) {
            const dst = await this._dst.worldInfo.get(handle, name);
            if (!recordsEqual('world', doc, dst)) {
                throw new Error(`world verify mismatch for ${name}`);
            }
        }
        for (const { key, record } of sourceData.chats) {
            const dst = await this._dst.chat.get(handle, key.charDir, key.name, {
                isGroup: !!key.isGroup,
                groupId: key.groupId,
            });
            if (!recordsEqual('chat', record, dst)) {
                throw new Error(
                    `chat verify mismatch for ${key.charDir || '(group)'}::${key.name}`
                    + (key.isGroup ? ` (groupId=${key.groupId})` : ''),
                );
            }
        }
        for (const { key, namespace, doc } of sourceData.chatStates) {
            const dst = await this._dst.chat.getState(handle, key.charDir, key.name, namespace, {
                isGroup: !!key.isGroup,
                groupId: key.groupId,
            });
            if (!recordsEqual('chat-state', doc, dst)) {
                throw new Error(
                    `chat state verify mismatch for ${key.charDir || '(group)'}::${key.name}::${namespace}`,
                );
            }
        }
        for (const { bucket, name, doc } of sourceData.namedDocs) {
            const dst = await this._dst.namedDoc.get(handle, bucket, name);
            if (!recordsEqual('named-doc', doc, dst)) {
                throw new Error(`named-doc verify mismatch for ${bucket}/${name}`);
            }
        }
        for (const { id, doc } of sourceData.groups) {
            const dst = await this._dst.group.get(handle, id);
            if (!recordsEqual('group', doc, dst)) {
                throw new Error(`group verify mismatch for ${id}`);
            }
        }
        if (sourceData.stats != null) {
            const dst = await this._dst.stats.get(handle);
            if (!recordsEqual('stats', sourceData.stats, dst)) {
                throw new Error('stats verify mismatch');
            }
        }
    }
}
