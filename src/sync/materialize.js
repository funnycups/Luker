/**
 * Engine-agnostic projection between repository records and the canonical
 * snapshot tree. Preset identities use the shared path codec in every engine;
 * other SQL records retain the live filesystem representation.
 *
 * Filesystem preset sources retain their owned physical layout while their
 * snapshots use canonical paths. Other filesystem categories are read directly.
 *
 * Partial-failure recovery: re-run sync. `materializeUserDataIntoWorkdir`
 * re-reads current repo state, the snapshot tree-diff drops to empty if the
 * previous run finished, and `dematerializeWorkdirIntoUserData` performs
 * per-record idempotent saves driven by `tx.putResource`. Integrity tokens
 * rotate on each save; nothing is depending on a single atomic batch.
 *
 * Category scope: this module touches ONLY the categories whose payload
 * lives in the engine in sqlite/mysql/postgres mode — chats, worlds,
 * presets, named-docs (themes/movingUI/quickReplies), groups, settings,
 * stats. Everything else (characters, avatars, assets, …) stays on disk
 * in every engine and is handled by the snapshot walker directly.
 *
 * @module sync/materialize
 */

import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { PRESET_FOLDER_BY_API_ID } from '../storage/repositories/preset-repo.js';
import { BUCKET_TO_DIR } from '../storage/repositories/named-doc-repo.js';
import { withReadOnlyBypass } from '../storage/read-only-mode.js';
import { assertConfinedPath } from '../storage/path-confinement.js';
import { readPresetInventory, readPresetEntry } from '../storage/preset-inventory.js';
import { encodePresetRecordPath, decodePresetRecordPath, buildPresetIdentityView } from './preset-projection.js';
import { assertDistinctFsDestinations } from './pipeline/path-identity.js';
import { isStagingEntryName } from './staging.js';
import { blobOidOf, readBlobBytes, readCommitFiles } from './pipeline/git-tree.js';
import { buildSidecarFilename, parseSidecarFilename, splitSidecarFilename } from '../storage/engines/sidecar-naming.js';

// One representative apiId per dirKey. Multiple apiIds share a folder
// (kobold + koboldhorde → koboldAI_Settings); iterating uniques keeps us
// from re-reading the same on-disk slot twice.
const PRESET_API_BY_DIR_KEY = (() => {
    const m = new Map();
    for (const [apiId, dirKey] of Object.entries(PRESET_FOLDER_BY_API_ID)) {
        if (!m.has(dirKey)) m.set(dirKey, apiId);
    }
    return m;
})();

// Sync category id → the dirKey the preset folder lives under. Categories
// not listed here aren't preset-shaped.
const PRESET_DIR_KEY_BY_CATEGORY = Object.freeze({
    'openai-presets': 'openAI_Settings',
    'novelai-presets': 'novelAI_Settings',
    'koboldai-presets': 'koboldAI_Settings',
    'textgen-presets': 'textGen_Settings',
    'instruct': 'instruct',
    'context': 'context',
    'sysprompt': 'sysprompt',
    'reasoning': 'reasoning',
});

// Sync category id → named-doc bucket.
const NAMED_DOC_BUCKET_BY_CATEGORY = Object.freeze({
    'themes': 'themes',
    'movingUI': 'movingUI',
    'quickreplies': 'quickReplies',
});

const PRESET_EXT = '.json';
const CHAT_EXT = '.jsonl';
// Shapes `parseSqlRecordBlob` tells apart: a chat file or one JSON document.
const CHAT_RECORD = Object.freeze({ kind: 'chat' });
const JSON_RECORD = Object.freeze({ kind: 'document' });

// Category ids whose payload lives in the storage engine when
// sqlite/mysql/postgres is active. Every other category stays on disk in all
// engines. This set MUST stay in sync with the dispatch table in
// `materializeUserDataIntoWorkdir` / `dematerializeWorkdirIntoUserData`:
// `buildSnapshotPlan` partitions the user's selection by it, and a category
// listed here but not materialized would be silently dropped from snapshots.
const SQL_BACKED_CATEGORY_IDS = Object.freeze(new Set([
    'settings',
    'stats',
    'worlds',
    'chats',
    ...Object.keys(PRESET_DIR_KEY_BY_CATEGORY),
    ...Object.keys(NAMED_DOC_BUCKET_BY_CATEGORY),
]));

/**
 * True when the category's data is stored inside the SQL engine in
 * sqlite/mysql/postgres mode. Disk-backed categories stay on the live
 * filesystem in every mode and must be snapshotted from there.
 *
 * @param {string} id
 * @returns {boolean}
 */
export function isSqlBackedCategory(id) {
    return SQL_BACKED_CATEGORY_IDS.has(id);
}

function toPosix(p) {
    return p.split(path.sep).join('/');
}

function relUnder(root, abs) {
    return toPosix(path.relative(root, abs));
}

/**
 * Delete every regular file under `root` that is not in `keep`, pruning
 * directories that end up empty. `root` may itself be a file path, in which
 * case it is unlinked when absent from `keep`.
 *
 * The materializer calls this per SQL-backed category after projecting the
 * engine state so a record deleted in the engine does not linger as a stale
 * workdir file. Without the sweep the snapshot walker would read the workdir
 * (which self-validates whatever is in it) and re-commit the deleted record,
 * so the deletion would never reach the peer.
 *
 * @param {string} root absolute path to a workdir file or directory
 * @param {Set<string>} keep absolute paths written this run
 * @returns {number} files deleted
 */
export function assertSafeProjectionPath(absPath, boundary) {
    try {
        assertConfinedPath({ boundary, absolutePath: absPath });
    } catch (error) {
        if (error.code === 'SYNC_UNSAFE_LIVE_PATH') error.code = 'UNSAFE_WORKDIR_PATH';
        throw error;
    }
}

function sweepWorkdirRoot(root, keep, boundary) {
    assertSafeProjectionPath(root, boundary);
    if (!fs.existsSync(root)) return 0;
    const stat = fs.lstatSync(root);
    if (stat.isFile()) {
        if (keep.has(root)) return 0;
        fs.unlinkSync(root);
        return 1;
    }
    if (!stat.isDirectory()) return 0;
    let deleted = 0;
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            // Same policy as the snapshot walkers: nested `.git` is never data.
            if (entry.name === '.git') continue;
            const abs = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(abs);
                if (fs.readdirSync(abs).length === 0) fs.rmdirSync(abs);
            } else if (entry.isFile() && !keep.has(abs)) {
                fs.unlinkSync(abs);
                deleted++;
            }
        }
    };
    walk(root);
    return deleted;
}

/** Absolute path of a directory entry under the workdir, anchored at the live root. */
function workdirPathFor(workdir, directories, absOrDir) {
    return path.join(workdir, relUnder(directories.root, absOrDir));
}

/**
 * Write a record's bytes. When the reference commits hold bytes for the
 * path that parse to the same value, those bytes are written instead:
 * MySQL JSON and Postgres JSONB return object keys in their own order, so
 * serializing the value again would change the bytes of an unchanged record.
 */
async function writeRecordFile(reuse, absPath, record, value, serialize) {
    assertSafeProjectionPath(absPath, reuse.boundary);
    const bytes = await reuse(absPath, record, value, Buffer.from(serialize(), 'utf-8'));
    if (reuse.planned.has(absPath)) throw Object.assign(new Error(`Duplicate projected destination at ${absPath}`), { code: 'PRESET_IDENTITY_DUPLICATE' });
    reuse.planned.set(absPath, { absPath, bytes });
    return bytes.length;
}

function writeJsonFile(reuse, absPath, value) {
    return writeRecordFile(reuse, absPath, JSON_RECORD, value, () => JSON.stringify(value, null, 4));
}

function writeChatJsonl(reuse, absPath, header, body) {
    return writeRecordFile(reuse, absPath, CHAT_RECORD, { header, body: body ?? [] }, () => {
        const lines = [JSON.stringify(header)];
        for (const m of body || []) lines.push(JSON.stringify(m));
        return lines.join('\n') + '\n';
    });
}

function readChatJsonl(absPath) {
    const raw = fs.readFileSync(absPath, 'utf-8');
    const lines = raw.split('\n').filter(l => l.length > 0);
    if (lines.length === 0) return null;
    let header;
    try {
        header = JSON.parse(lines[0]);
    } catch {
        console.warn(`[sync] skipping malformed chat header at ${absPath}`);
        return null;
    }
    const body = [];
    for (let i = 1; i < lines.length; i++) {
        try {
            body.push(JSON.parse(lines[i]));
        } catch {
            console.warn(`[sync] skipping malformed chat message line ${i + 1} at ${absPath}`);
        }
    }
    return { header, body };
}

function listDirSafe(absDir) {
    if (!fs.existsSync(absDir)) return [];
    return fs.readdirSync(absDir);
}

/**
 * Reject traversal segments and repository metadata, independently of
 * accepted dot-leading or double-dot resource names.
 */
function isUnsafeEntryName(entry) {
    if (typeof entry !== 'string' || entry.length === 0) return true;
    if (entry === '.' || entry === '..' || entry === '.git' || entry === '.DS_Store') return true;
    if (entry.includes('/') || entry.includes('\\')) return true;
    if (entry.includes('\0')) return true;
    return false;
}

// --- materializers (per category) -----------------------------------------

async function materializeSettings({ tx, handle, directories, workdir, written, reuse }) {
    const rec = await tx.getResource({ kind: 'settings', handle });
    if (rec == null) return { filesWritten: 0, bytes: 0 };
    const out = path.join(workdir, 'settings.json');
    written.add(out);
    return { filesWritten: 1, bytes: await writeJsonFile(reuse, out, rec) };
}

async function materializeStats({ tx, handle, directories, workdir, written, reuse }) {
    const rec = await tx.getResource({ kind: 'stats', handle });
    if (rec == null) return { filesWritten: 0, bytes: 0 };
    const out = path.join(workdir, 'stats.json');
    written.add(out);
    return { filesWritten: 1, bytes: await writeJsonFile(reuse, out, rec) };
}

async function materializeWorlds({ tx, handle, directories, workdir, written, reuse }) {
    let filesWritten = 0;
    let bytes = 0;
    const entries = await tx.listResources({ kind: 'world', handle });
    for (const entry of entries) {
        const name = entry?.key?.name;
        if (!name) continue;
        const doc = await tx.getResource({ kind: 'world', handle, name });
        if (doc == null) continue;
        const rel = relUnder(directories.root, path.join(directories.worlds, `${name}.json`));
        const abs = path.join(workdir, rel);
        written.add(abs);
        bytes += await writeJsonFile(reuse, abs, doc);
        filesWritten++;
    }
    return { filesWritten, bytes };
}

async function materializePreset({ tx, handle, directories, workdir, written, reuse, dirKey, engine }) {
    const apiId = PRESET_API_BY_DIR_KEY.get(dirKey);
    if (!apiId) throw new Error(`materialize: unknown preset dirKey ${dirKey}`);
    let filesWritten = 0;
    let bytes = 0;
    const folder = directories[dirKey];
    if (typeof folder !== 'string') {
        throw new Error(`materialize: directories.${dirKey} missing`);
    }
    if (engine.kind === 'fs') {
        const inventory = readPresetInventory({ folder, dirKey, boundary: directories.root });
        const owned = new Set();
        for (const entry of inventory.entries.values()) {
            const value = readPresetEntry(entry);
            const abs = path.join(workdir, ...encodePresetRecordPath(directories, entry.record).split('/'));
            owned.add(entry.absolutePath);
            written.add(abs);
            bytes += await writeRecordFile(reuse, abs, entry.record, value.doc, () => value.bytes);
            filesWritten++;
        }
        const collectUnowned = async dir => {
            assertConfinedPath({ boundary: directories.root, absolutePath: dir });
            let children;
            try { children = fs.readdirSync(dir, { withFileTypes: true }); } catch (error) {
                if (error.code === 'ENOENT') return;
                throw error;
            }
            for (const child of children) {
                if (child.name === '.git' || isStagingEntryName(child.name)) continue;
                const src = path.join(dir, child.name);
                if (child.isDirectory()) await collectUnowned(src);
                else if (child.isFile() && !owned.has(src)) {
                    assertConfinedPath({ boundary: directories.root, absolutePath: src });
                    const abs = path.join(workdir, relUnder(directories.root, src));
                    assertSafeProjectionPath(abs, reuse.boundary);
                    if (reuse.planned.has(abs)) throw Object.assign(new Error(`Unowned file collides with a preset projection at ${src}`), { code: 'PRESET_IDENTITY_DUPLICATE' });
                    const data = fs.readFileSync(src);
                    reuse.planned.set(abs, { absPath: abs, bytes: data });
                    written.add(abs);
                    bytes += data.length;
                    filesWritten++;
                }
            }
        };
        await collectUnowned(folder);
        return { filesWritten, bytes };
    }
    const entries = await tx.listResources({ kind: 'preset', handle, apiId, dirKey });
    for (const entry of entries) {
        const name = entry?.key?.name;
        if (!name) continue;
        const key = { kind: 'preset', handle, dirKey, name };
        const doc = await tx.getResource(key);
        if (doc == null) continue;
        const rel = encodePresetRecordPath(directories, { kind: 'preset', dirKey, name });
        const abs = path.join(workdir, rel);
        written.add(abs);
        bytes += await writeJsonFile(reuse, abs, doc);
        filesWritten++;
    }
    // Preset state accepts absent parents in all SQL engines. Enumerate it
    // independently so accepted orphan records survive fresh snapshots.
    const states = await tx.listPresetStateRecords({ handle, dirKey });
    for (const { name, namespace: ns } of states) {
        const key = { kind: 'preset', handle, dirKey, name };
        const stateDoc = await tx.getPresetState(key, ns);
        if (stateDoc == null) continue;
        const sidecarRel = encodePresetRecordPath(directories, { kind: 'preset-state', dirKey, name, namespace: ns });
        const sidecarAbs = path.join(workdir, sidecarRel);
        written.add(sidecarAbs);
        bytes += await writeJsonFile(reuse, sidecarAbs, stateDoc);
        filesWritten++;
    }
    return { filesWritten, bytes };
}

async function materializeNamedDoc({ tx, handle, directories, workdir, written, reuse, bucket }) {
    const dirKey = BUCKET_TO_DIR[bucket];
    if (!dirKey) throw new Error(`materialize: invalid named-doc bucket ${bucket}`);
    const folder = directories[dirKey];
    if (typeof folder !== 'string') {
        throw new Error(`materialize: directories.${dirKey} missing`);
    }
    let filesWritten = 0;
    let bytes = 0;
    const entries = await tx.listResources({ kind: 'named-doc', handle, bucket });
    for (const entry of entries) {
        const name = entry?.key?.name;
        if (!name) continue;
        const doc = await tx.getResource({ kind: 'named-doc', handle, bucket, name });
        if (doc == null) continue;
        const rel = relUnder(directories.root, path.join(folder, `${name}.json`));
        const abs = path.join(workdir, rel);
        written.add(abs);
        bytes += await writeJsonFile(reuse, abs, doc);
        filesWritten++;
    }
    return { filesWritten, bytes };
}

async function materializeChats({ tx, handle, directories, workdir, written, reuse }) {
    let filesWritten = 0;
    let bytes = 0;

    // Per-character chats — listResources with isGroup=false.
    const perChar = await tx.listResources({ kind: 'chat', handle, isGroup: false });
    for (const entry of perChar) {
        const k = entry.key;
        const key = { kind: 'chat', handle, charDir: k.charDir, name: k.name, isGroup: false };
        const chat = await tx.getResource(key);
        if (chat == null) continue;
        const header = {
            ...chat.header,
            chat_metadata: {
                ...(chat.header?.chat_metadata ?? {}),
                integrity: chat.integrity,
            },
        };
        const abs = path.join(workdir, relUnder(
            directories.root,
            path.join(directories.chats, k.charDir, `${k.name}${CHAT_EXT}`),
        ));
        written.add(abs);
        bytes += await writeChatJsonl(reuse, abs, header, chat.body);
        filesWritten++;
        const namespaces = await tx.listChatStateNamespaces(key);
        for (const ns of namespaces) {
            const stateDoc = await tx.getChatState(key, ns);
            if (stateDoc == null) continue;
            const sidecarAbs = path.join(workdir, relUnder(
                directories.root,
                path.join(directories.chats, k.charDir, buildSidecarFilename(k.name, ns)),
            ));
            written.add(sidecarAbs);
            bytes += await writeJsonFile(reuse, sidecarAbs, stateDoc);
            filesWritten++;
        }
    }

    // Group chats — enumerate via groups so we get the canonical chat ids.
    const groupRows = await tx.listResources({ kind: 'group', handle });
    for (const groupRow of groupRows) {
        const groupId = groupRow?.key?.id;
        if (!groupId) continue;
        const groupDoc = await tx.getResource({ kind: 'group', handle, id: groupId });
        if (groupDoc == null) continue;
        // Write the group doc itself
        const groupAbs = path.join(workdir, relUnder(
            directories.root,
            path.join(directories.groups, `${groupId}.json`),
        ));
        written.add(groupAbs);
        bytes += await writeJsonFile(reuse, groupAbs, groupDoc);
        filesWritten++;
        if (!Array.isArray(groupDoc.chats)) continue;
        for (const chatId of groupDoc.chats) {
            const key = {
                kind: 'chat', handle, charDir: null, name: chatId,
                isGroup: true, groupId: chatId,
            };
            const chat = await tx.getResource(key);
            if (chat == null) continue;
            const header = {
                ...chat.header,
                chat_metadata: {
                    ...(chat.header?.chat_metadata ?? {}),
                    integrity: chat.integrity,
                },
            };
            const abs = path.join(workdir, relUnder(
                directories.root,
                path.join(directories.groupChats, `${chatId}${CHAT_EXT}`),
            ));
            written.add(abs);
            bytes += await writeChatJsonl(reuse, abs, header, chat.body);
            filesWritten++;
            const namespaces = await tx.listChatStateNamespaces(key);
            for (const ns of namespaces) {
                const stateDoc = await tx.getChatState(key, ns);
                if (stateDoc == null) continue;
                const sidecarAbs = path.join(workdir, relUnder(
                    directories.root,
                    path.join(directories.groupChats, buildSidecarFilename(chatId, ns)),
                ));
                written.add(sidecarAbs);
                bytes += await writeJsonFile(reuse, sidecarAbs, stateDoc);
                filesWritten++;
            }
        }
    }

    return { filesWritten, bytes };
}

// --- dematerialize ---------------------------------------------------------

function listSidecarsForBase(dir, base) {
    const out = new Map();
    for (const entry of listDirSafe(dir)) {
        if (isUnsafeEntryName(entry)) continue;
        const ns = parseSidecarFilename(entry, base);
        if (ns !== null) out.set(ns, path.join(dir, entry));
    }
    return out;
}

function readJsonFile(absPath) {
    if (!fs.existsSync(absPath)) return null;
    const raw = fs.readFileSync(absPath, 'utf-8');
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch {
        console.warn(`[sync] skipping malformed JSON at ${absPath}`);
        return null;
    }
}

async function dematerializeSettings({ tx, handle, directories, workdir, stats }) {
    const abs = path.join(workdir, 'settings.json');
    if (fs.existsSync(abs)) {
        const doc = readJsonFile(abs);
        await tx.putResource({ kind: 'settings', handle }, { doc });
        stats.recordsWritten++;
    } else {
        const existing = await tx.getResource({ kind: 'settings', handle });
        if (existing != null) {
            await tx.deleteResource({ kind: 'settings', handle });
            stats.recordsDeleted++;
        }
    }
}

async function dematerializeStats({ tx, handle, directories, workdir, stats }) {
    const abs = path.join(workdir, 'stats.json');
    if (fs.existsSync(abs)) {
        const doc = readJsonFile(abs);
        await tx.putResource({ kind: 'stats', handle }, { doc });
        stats.recordsWritten++;
    } else {
        const existing = await tx.getResource({ kind: 'stats', handle });
        if (existing != null) {
            await tx.deleteResource({ kind: 'stats', handle });
            stats.recordsDeleted++;
        }
    }
}

async function dematerializeWorlds({ tx, handle, directories, workdir, stats }) {
    const worldsAbs = path.join(workdir, relUnder(directories.root, directories.worlds));
    const present = new Set();
    for (const entry of listDirSafe(worldsAbs)) {
        if (isUnsafeEntryName(entry)) continue;
        if (!entry.endsWith('.json')) continue;
        const name = entry.slice(0, -'.json'.length);
        present.add(name);
        const doc = readJsonFile(path.join(worldsAbs, entry));
        if (doc == null) continue;
        await tx.putResource({ kind: 'world', handle, name }, { doc });
        stats.recordsWritten++;
    }
    const existing = await tx.listResources({ kind: 'world', handle });
    for (const e of existing) {
        const name = e?.key?.name;
        if (name && !present.has(name)) {
            await tx.deleteResource({ kind: 'world', handle, name });
            stats.recordsDeleted++;
        }
    }
}

async function dematerializePreset({ tx, handle, directories, workdir, stats, dirKey }) {
    const apiId = PRESET_API_BY_DIR_KEY.get(dirKey);
    if (!apiId) throw new Error(`dematerialize: unknown preset dirKey ${dirKey}`);
    const folder = directories[dirKey];
    if (typeof folder !== 'string') {
        throw new Error(`dematerialize: directories.${dirKey} missing`);
    }
    const folderAbs = path.join(workdir, relUnder(directories.root, folder));

    const inventory = readPresetInventory({ folder: folderAbs, dirKey, boundary: workdir });
    const records = [...inventory.entries.values()].map(entry => ({ record: entry.record, doc: readPresetEntry(entry).doc }));
    const presentNames = new Set(records.filter(entry => entry.record.kind === 'preset').map(entry => entry.record.name));
    const presentStates = new Set(records.filter(entry => entry.record.kind === 'preset-state').map(entry => JSON.stringify([entry.record.name, entry.record.namespace])));
    for (const { name, namespace } of await tx.listPresetStateRecords({ handle, dirKey })) {
        if (!presentStates.has(JSON.stringify([name, namespace]))) {
            await tx.deletePresetState({ kind: 'preset', handle, dirKey, name }, namespace);
            stats.recordsDeleted++;
        }
    }
    const existing = await tx.listResources({ kind: 'preset', handle, apiId, dirKey });
    for (const e of existing) {
        const name = e?.key?.name;
        if (name && !presentNames.has(name)) {
            await tx.deleteResource({ kind: 'preset', handle, dirKey, name });
            stats.recordsDeleted++;
        }
    }
    for (const { record, doc } of records) {
        const key = { kind: 'preset', handle, dirKey, name: record.name };
        if (record.kind === 'preset') await tx.putResource(key, { doc });
        else await tx.putPresetState(key, record.namespace, doc);
        stats.recordsWritten++;
    }
}

async function dematerializeNamedDoc({ tx, handle, directories, workdir, stats, bucket }) {
    const dirKey = BUCKET_TO_DIR[bucket];
    if (!dirKey) throw new Error(`dematerialize: invalid named-doc bucket ${bucket}`);
    const folder = directories[dirKey];
    if (typeof folder !== 'string') {
        throw new Error(`dematerialize: directories.${dirKey} missing`);
    }
    const folderAbs = path.join(workdir, relUnder(directories.root, folder));
    const present = new Set();
    for (const entry of listDirSafe(folderAbs)) {
        if (isUnsafeEntryName(entry)) continue;
        if (!entry.endsWith('.json')) continue;
        const name = entry.slice(0, -'.json'.length);
        present.add(name);
        const doc = readJsonFile(path.join(folderAbs, entry));
        if (doc == null) continue;
        await tx.putResource({ kind: 'named-doc', handle, bucket, name }, { doc });
        stats.recordsWritten++;
    }
    const existing = await tx.listResources({ kind: 'named-doc', handle, bucket });
    for (const e of existing) {
        const name = e?.key?.name;
        if (name && !present.has(name)) {
            await tx.deleteResource({ kind: 'named-doc', handle, bucket, name });
            stats.recordsDeleted++;
        }
    }
}

async function dematerializeChats({ tx, handle, directories, workdir, stats }) {
    // Per-character chats
    const chatsAbs = path.join(workdir, relUnder(directories.root, directories.chats));
    const presentPerChar = new Set(); // `${charDir}\x00${name}`
    for (const charDir of listDirSafe(chatsAbs)) {
        if (isUnsafeEntryName(charDir)) continue;
        const charPath = path.join(chatsAbs, charDir);
        try { if (!fs.statSync(charPath).isDirectory()) continue; } catch { continue; }
        const chatFiles = listDirSafe(charPath).filter(e => !isUnsafeEntryName(e) && e.endsWith(CHAT_EXT));
        for (const entry of chatFiles) {
            const name = entry.slice(0, -CHAT_EXT.length);
            presentPerChar.add(`${charDir}\x00${name}`);
            const abs = path.join(charPath, entry);
            const parsed = readChatJsonl(abs);
            if (parsed == null) continue;
            const integrity = parsed.header?.chat_metadata?.integrity ?? '';
            const now = Math.floor(Date.now() / 1000);
            const key = { kind: 'chat', handle, charDir, name, isGroup: false };
            await tx.putResource(key, {
                header: parsed.header,
                body: parsed.body,
                integrity,
                updatedAt: now,
                createdAt: now,
            });
            stats.recordsWritten++;
            const sidecars = listSidecarsForBase(charPath, name);
            for (const [ns, sidecarAbs] of sidecars) {
                const stateDoc = readJsonFile(sidecarAbs);
                if (stateDoc == null) continue;
                await tx.putChatState(key, ns, stateDoc);
                stats.recordsWritten++;
            }
        }
    }

    // Group chats
    const groupChatsAbs = path.join(workdir, relUnder(directories.root, directories.groupChats));
    const presentGroupChats = new Set();
    for (const entry of listDirSafe(groupChatsAbs)) {
        if (isUnsafeEntryName(entry)) continue;
        if (!entry.endsWith(CHAT_EXT)) continue;
        const chatId = entry.slice(0, -CHAT_EXT.length);
        presentGroupChats.add(chatId);
        const abs = path.join(groupChatsAbs, entry);
        const parsed = readChatJsonl(abs);
        if (parsed == null) continue;
        const integrity = parsed.header?.chat_metadata?.integrity ?? '';
        const now = Math.floor(Date.now() / 1000);
        // Group rows must already exist for putChatState to attach sidecars.
        // putResource on a chat row with isGroup=true creates the parent.
        const key = {
            kind: 'chat', handle, charDir: null, name: chatId,
            isGroup: true, groupId: chatId,
        };
        await tx.putResource(key, {
            header: parsed.header,
            body: parsed.body,
            integrity,
            updatedAt: now,
            createdAt: now,
        });
        stats.recordsWritten++;
        const sidecars = listSidecarsForBase(groupChatsAbs, chatId);
        for (const [ns, sidecarAbs] of sidecars) {
            const stateDoc = readJsonFile(sidecarAbs);
            if (stateDoc == null) continue;
            await tx.putChatState(key, ns, stateDoc);
            stats.recordsWritten++;
        }
    }

    // Groups (the `groups/` JSON files themselves — separate from group chats).
    const groupsAbs = path.join(workdir, relUnder(directories.root, directories.groups));
    const presentGroups = new Set();
    for (const entry of listDirSafe(groupsAbs)) {
        if (isUnsafeEntryName(entry)) continue;
        if (!entry.endsWith('.json')) continue;
        const id = entry.slice(0, -'.json'.length);
        presentGroups.add(id);
        const doc = readJsonFile(path.join(groupsAbs, entry));
        if (doc == null) continue;
        await tx.putResource({ kind: 'group', handle, id }, { doc });
        stats.recordsWritten++;
    }

    // Delete chats / groups no longer present.
    const existingChats = await tx.listResources({ kind: 'chat', handle });
    for (const e of existingChats) {
        const k = e.key;
        if (k.isGroup) {
            if (!presentGroupChats.has(k.name)) {
                await tx.deleteResource({
                    kind: 'chat', handle, charDir: null, name: k.name,
                    isGroup: true, groupId: k.groupId ?? k.name,
                });
                stats.recordsDeleted++;
            }
        } else {
            if (!presentPerChar.has(`${k.charDir}\x00${k.name}`)) {
                await tx.deleteResource({
                    kind: 'chat', handle, charDir: k.charDir, name: k.name, isGroup: false,
                });
                stats.recordsDeleted++;
            }
        }
    }
    const existingGroups = await tx.listResources({ kind: 'group', handle });
    for (const e of existingGroups) {
        const id = e?.key?.id;
        if (id && !presentGroups.has(id)) {
            await tx.deleteResource({ kind: 'group', handle, id });
            stats.recordsDeleted++;
        }
    }
}

// --- per-record access for live reconcile ----------------------------------

/**
 * @typedef {(
 *   { kind: 'settings' } | { kind: 'stats' } | { kind: 'world', name: string }
 *   | { kind: 'preset', dirKey: string, name: string }
 *   | { kind: 'preset-state', dirKey: string, name: string, namespace: string }
 *   | { kind: 'named-doc', bucket: string, name: string }
 *   | { kind: 'group', id: string }
 *   | { kind: 'chat', charDir: string|null, name: string, isGroup: boolean }
 *   | { kind: 'chat-state', charDir: string|null, name: string, isGroup: boolean, namespace: string }
 * )} SqlRecordRef
 */

function segmentsUnder(directories, dirAbs, relPath) {
    if (typeof dirAbs !== 'string') return null;
    const prefix = relUnder(directories.root, dirAbs);
    if (!relPath.startsWith(`${prefix}/`)) return null;
    return relPath.slice(prefix.length + 1).split('/');
}

function chatRecordFromFileName(charDir, isGroup, fileName) {
    if (fileName.endsWith(CHAT_EXT)) {
        return { kind: 'chat', charDir, name: fileName.slice(0, -CHAT_EXT.length), isGroup };
    }
    const sidecar = splitSidecarFilename(fileName);
    return sidecar ? { kind: 'chat-state', charDir, name: sidecar.base, isGroup, namespace: sidecar.namespace } : null;
}

/**
 * Map a workdir path (POSIX, relative to the user root) to the engine
 * record the materializer projects there. Returns null for paths the
 * materializer never writes; the same unsafe-name rules as dematerialize
 * apply.
 *
 * @param {object} directories
 * @param {string} relPath
 * @returns {SqlRecordRef | null}
 */
export function describeSqlRecordPath(directories, relPath) {
    if (typeof relPath !== 'string' || relPath.split('/').some(isUnsafeEntryName)) return null;
    if (relPath === 'settings.json') return { kind: 'settings' };
    if (relPath === 'stats.json') return { kind: 'stats' };
    const world = segmentsUnder(directories, directories.worlds, relPath);
    if (world) {
        return world.length === 1 && world[0].endsWith('.json') ? { kind: 'world', name: world[0].slice(0, -'.json'.length) } : null;
    }
    const preset = decodePresetRecordPath(directories, relPath);
    if (preset) return preset;
    for (const bucket of Object.values(NAMED_DOC_BUCKET_BY_CATEGORY)) {
        const doc = segmentsUnder(directories, directories[BUCKET_TO_DIR[bucket]], relPath);
        if (!doc) continue;
        return doc.length === 1 && doc[0].endsWith('.json') ? { kind: 'named-doc', bucket, name: doc[0].slice(0, -'.json'.length) } : null;
    }
    const group = segmentsUnder(directories, directories.groups, relPath);
    if (group) return group.length === 1 && group[0].endsWith('.json') ? { kind: 'group', id: group[0].slice(0, -'.json'.length) } : null;
    const groupChat = segmentsUnder(directories, directories.groupChats, relPath);
    if (groupChat) return groupChat.length === 1 ? chatRecordFromFileName(null, true, groupChat[0]) : null;
    const chat = segmentsUnder(directories, directories.chats, relPath);
    if (chat) return chat.length === 2 ? chatRecordFromFileName(chat[0], false, chat[1]) : null;
    return null;
}

/**
 * Workdir path of the chat or preset record that owns the state companion
 * at `relPath`. Null for any other path.
 *
 * @param {object} directories
 * @param {string} relPath
 * @returns {string | null}
 */
export function subRecordParentPath(directories, relPath) {
    const record = describeSqlRecordPath(directories, relPath);
    if (record?.kind === 'preset-state') return encodePresetRecordPath(directories, { kind: 'preset', dirKey: record.dirKey, name: record.name });
    const ext = record?.kind === 'chat-state' ? CHAT_EXT : record?.kind === 'preset-state' ? PRESET_EXT : null;
    if (!ext) return null;
    return `${relPath.slice(0, relPath.lastIndexOf('/') + 1)}${record.name}${ext}`;
}

function chatKeyFor(handle, record) {
    return record.isGroup
        ? { kind: 'chat', handle, charDir: null, name: record.name, isGroup: true, groupId: record.name }
        : { kind: 'chat', handle, charDir: record.charDir, name: record.name, isGroup: false };
}

function presetKeyFor(handle, record) {
    return { kind: 'preset', handle, dirKey: record.dirKey, name: record.name };
}

function documentKeyFor(handle, record) {
    switch (record.kind) {
        case 'settings': return { kind: 'settings', handle };
        case 'stats': return { kind: 'stats', handle };
        case 'world': return { kind: 'world', handle, name: record.name };
        case 'preset': return presetKeyFor(handle, record);
        case 'named-doc': return { kind: 'named-doc', handle, bucket: record.bucket, name: record.name };
        case 'group': return { kind: 'group', handle, id: record.id };
        default: throw new Error(`no document key for record kind ${record.kind}`);
    }
}

function withChatIntegrity(header, integrity) {
    return { ...header, chat_metadata: { ...(header?.chat_metadata ?? {}), integrity } };
}

/**
 * Current engine value of a record, shaped like the file the materializer
 * writes for it. Absent records read as null.
 *
 * @param {any} tx
 * @param {string} handle
 * @param {SqlRecordRef} record
 * @returns {Promise<object | null>}
 */
export async function readSqlRecordValue(tx, handle, record) {
    if (record.kind === 'chat') {
        const chat = await tx.getResource(chatKeyFor(handle, record));
        if (chat == null) return null;
        return { header: withChatIntegrity(chat.header, chat.integrity), body: chat.body ?? [] };
    }
    if (record.kind === 'chat-state') return (await tx.getChatState(chatKeyFor(handle, record), record.namespace)) ?? null;
    if (record.kind === 'preset-state') return (await tx.getPresetState(presetKeyFor(handle, record), record.namespace)) ?? null;
    return (await tx.getResource(documentKeyFor(handle, record))) ?? null;
}

/**
 * State namespaces stored under a chat or preset record. Deleting such a
 * parent removes these sub-records with it. Other record kinds have none.
 *
 * @param {any} tx
 * @param {string} handle
 * @param {SqlRecordRef} record
 * @returns {Promise<string[]>}
 */
export async function listSqlSubRecordNamespaces(tx, handle, record) {
    if (record.kind === 'chat') return (await tx.listChatStateNamespaces(chatKeyFor(handle, record))) ?? [];
    if (record.kind === 'preset') return (await tx.listPresetStateNamespaces(presetKeyFor(handle, record))) ?? [];
    return [];
}

/**
 * Parse a workdir blob into the value the engine stores for it. Chat
 * headers get `chat_metadata.integrity` defaulted to '' because the engine
 * stores the integrity it is given. Unparseable bytes return undefined.
 *
 * @param {SqlRecordRef} record
 * @param {Buffer | Uint8Array} bytes
 * @returns {object | undefined}
 */
export function parseSqlRecordBlob(record, bytes) {
    const text = Buffer.from(bytes).toString('utf8');
    try {
        if (record.kind === 'chat') {
            const lines = text.split('\n').filter(line => line.length > 0);
            if (lines.length === 0) return undefined;
            const [header, ...body] = lines.map(line => JSON.parse(line));
            if (!header || typeof header !== 'object' || Array.isArray(header)) return undefined;
            return { header: withChatIntegrity(header, header.chat_metadata?.integrity ?? ''), body };
        }
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

/**
 * Put `value` into the engine for `record`, or delete it when `value` is
 * null. Writes match the corresponding dematerialize path.
 *
 * @param {any} tx
 * @param {string} handle
 * @param {SqlRecordRef} record
 * @param {object | null} value
 * @returns {Promise<void>}
 */
export async function writeSqlRecordValue(tx, handle, record, value) {
    if (record.kind === 'chat') {
        const key = chatKeyFor(handle, record);
        if (value === null) {
            await tx.deleteResource(key);
            return;
        }
        const now = Math.floor(Date.now() / 1000);
        await tx.putResource(key, {
            header: value.header,
            body: value.body,
            integrity: value.header?.chat_metadata?.integrity ?? '',
            updatedAt: now,
            createdAt: now,
        });
        return;
    }
    if (record.kind === 'chat-state') {
        const key = chatKeyFor(handle, record);
        if (value === null) await tx.deleteChatState(key, record.namespace);
        else await tx.putChatState(key, record.namespace, value);
        return;
    }
    if (record.kind === 'preset-state') {
        const key = presetKeyFor(handle, record);
        if (value === null) await tx.deletePresetState(key, record.namespace);
        else await tx.putPresetState(key, record.namespace, value);
        return;
    }
    const key = documentKeyFor(handle, record);
    if (value === null) await tx.deleteResource(key);
    else await tx.putResource(key, { doc: value });
}

// --- public API ------------------------------------------------------------

/**
 * Rewrite every absolute path in `directories` so it points under `workdir`
 * instead of `directories.root`. The orchestrator's snapshot pre-step in
 * SQL-engine modes uses this view to anchor `snapshotLiveToShadow`'s
 * category resolvers at the workdir where the materializer just dropped
 * the records, instead of at the (empty) live root that would otherwise
 * yield zero desired files.
 *
 * Every directory in `directories` whose path starts with `directories.root`
 * gets re-anchored; anything else (an absolute path outside the user root,
 * which is not a shape we expect) is left untouched so a typo here never
 * silently escapes the workdir. `directories.root` itself is replaced
 * wholesale so `path.relative(directories.root, ...)` calls inside the
 * walker still produce the right rel paths.
 *
 * Pure — no I/O. The caller is responsible for ensuring the workdir
 * exists (the materializer does that as its first step).
 *
 * @param {object} directories — UserDirectoryList shape (root + per-category absolute paths)
 * @param {string} workdir — absolute path to the shadow workdir
 * @returns {object} same shape as `directories`, every path re-anchored under workdir
 */
export function buildWorkdirDirectoriesView(directories, workdir) {
    if (!directories || typeof directories.root !== 'string') {
        throw new TypeError('buildWorkdirDirectoriesView: directories.root required');
    }
    if (typeof workdir !== 'string' || workdir.length === 0) {
        throw new TypeError('buildWorkdirDirectoriesView: workdir required');
    }
    const root = directories.root;
    const out = { ...directories, root: workdir };
    for (const [key, value] of Object.entries(directories)) {
        if (key === 'root') continue;
        if (typeof value !== 'string') continue;
        const rel = path.relative(root, value);
        // Skip paths that escape the user root (rel starts with '..'); leave
        // them as-is rather than silently re-rooting somewhere unexpected.
        if (rel.startsWith('..')) continue;
        out[key] = path.join(workdir, rel);
    }
    return out;
}

/**
 * Compute the arguments for one `snapshotLiveToShadow` call so the snapshot
 * walker reads every enabled category from the place its bytes actually live.
 *
 * fs engine: the live tree IS the workdir shape, so the walker reads
 * `directories` anchored at `directories.root` for all categories.
 *
 * SQL engines: the materializer projected only the SQL-backed categories
 * (worlds, chats, presets, …) into the workdir; the disk-backed categories
 * (characters, avatars, …) still live under the real user root. The plan
 * therefore anchors the SQL-backed subset at the workdir via
 * `buildWorkdirDirectoriesView` and hands the disk-backed subset over as an
 * additional source the walker unions into the same commit. Anchoring both
 * subsets at the workdir, or neither, is what previously dropped disk-backed
 * categories from snapshots — and worse, made the reconcile deletion sweep
 * treat their live files as absent from the desired set and wipe them.
 *
 * Pure — no I/O. `workdir` must already exist (materialize creates it).
 *
 * @param {object} opts
 * @param {{ kind: string }} opts.engine
 * @param {object} opts.directories — live UserDirectoryList
 * @param {string[]} opts.categories — user's enabled category ids
 * @param {string} opts.workdir — absolute path to the shadow workdir
 * @returns {{
 *   directories: object,
 *   liveRoot: string,
 *   enabledCategoryIds: string[],
 *   additionalSources: Array<{directories: object, liveRoot: string, enabledCategoryIds: string[]}>,
 * }}
 */
export function buildSnapshotPlan({ engine, directories, categories, workdir }) {
    const enabled = Array.isArray(categories) ? categories : [];
    if (engine.kind === 'fs' && !enabled.some(id => Object.hasOwn(PRESET_DIR_KEY_BY_CATEGORY, id))) return { directories, liveRoot: directories.root, enabledCategoryIds: enabled, additionalSources: [] };
    const projected = id => engine.kind !== 'fs' ? isSqlBackedCategory(id) : Object.hasOwn(PRESET_DIR_KEY_BY_CATEGORY, id);
    const sqlBacked = enabled.filter(projected);
    const diskBacked = enabled.filter(id => !projected(id));
    const plan = {
        directories: buildWorkdirDirectoriesView(directories, workdir),
        liveRoot: workdir,
        enabledCategoryIds: sqlBacked,
        additionalSources: [],
    };
    if (diskBacked.length > 0) {
        plan.additionalSources.push({
            directories,
            liveRoot: directories.root,
            enabledCategoryIds: diskBacked,
        });
    }
    return plan;
}

/**
 * Build the lookup `writeRecordFile` uses: the bytes the reference commits
 * hold for a workdir path, provided they parse to `value`, else `serialized`.
 * A reference entry with the oid of `serialized` matches without being read.
 *
 * @returns {Promise<(absPath: string, record: SqlRecordRef, value: object, serialized: Buffer) => Promise<Buffer>>}
 */
async function referenceBytesReader({ gitdir, workdir, referenceOids, directories, engine }) {
    const oids = [...new Set(referenceOids.filter(Boolean))];
    if (!gitdir || oids.length === 0) return async (_absPath, _record, _value, serialized) => serialized;
    const trees = await Promise.all(oids.map(async commitOid => buildPresetIdentityView({ directories, files: await readCommitFiles({ gitdir, commitOid }) }).files));
    return async (absPath, record, value, serialized) => {
        if (engine.kind === 'fs') return serialized;
        const relPath = relUnder(workdir, absPath);
        const serializedOid = blobOidOf(serialized);
        const checked = new Set();
        for (const files of trees) {
            const entry = files.get(relPath);
            if (!entry || checked.has(entry.oid)) continue;
            if (entry.oid === serializedOid) return serialized;
            checked.add(entry.oid);
            const bytes = await readBlobBytes({ gitdir, oid: entry.oid });
            if (isDeepStrictEqual(parseSqlRecordBlob(record, bytes), value)) return bytes;
        }
        return serialized;
    };
}

/**
 * Project repository payload into the canonical workdir. Filesystem engines
 * project preset categories only; other filesystem categories stay live.
 *
 * All enabled SQL-backed categories are read inside one engine transaction,
 * so the projected tree is one consistent cut of the engine. The engine may
 * retry the transaction callback, so per-attempt state lives inside it.
 *
 * After a category is projected, its workdir roots are swept: any file the
 * engine no longer knows about is unlinked. The snapshot walker enumerates
 * the workdir itself, so without the sweep a record deleted in the engine
 * would stay in the desired set and never propagate to the peer.
 *
 * @param {object} opts
 * @param {string} opts.handle
 * @param {object} opts.directories
 * @param {string[]} opts.categories
 * @param {string} opts.workdir
 * @param {{ kind: string, withTransaction: Function }} opts.engine
 * @param {string} [opts.gitdir] repository holding `referenceOids`
 * @param {Array<string | null>} [opts.referenceOids] commits whose bytes a
 *   record keeps when they parse to its current value, first match wins
 * @returns {Promise<{filesWritten: number, bytes: number}>}
 */
export async function materializeUserDataIntoWorkdir({
    handle, directories, categories, workdir, engine, gitdir, referenceOids = [],
}) {
    if (!engine || typeof engine.withTransaction !== 'function') {
        throw new TypeError('materializeUserDataIntoWorkdir: engine.withTransaction required');
    }
    const enabled = new Set((categories || []).filter(id => engine.kind !== 'fs' || Object.hasOwn(PRESET_DIR_KEY_BY_CATEGORY, id)));
    if (enabled.size === 0) return { filesWritten: 0, bytes: 0 };
    let boundary = path.resolve(directories.root);
    while (path.relative(boundary, workdir).startsWith(`..${path.sep}`) || path.relative(boundary, workdir) === '..') boundary = path.dirname(boundary);
    assertSafeProjectionPath(workdir, boundary);
    fs.mkdirSync(workdir, { recursive: true });
    const reuse = await referenceBytesReader({ gitdir, workdir, referenceOids, directories, engine });
    reuse.boundary = boundary;

    /** @type {Array<{ materialize: (tx: any, written: Set<string>) => Promise<{filesWritten: number, bytes: number}>, sweepRoots: () => string[] }>} */
    const steps = [];
    if (enabled.has('settings')) {
        steps.push({
            materialize: (tx, written) => materializeSettings({ tx, handle, directories, workdir, written, reuse }),
            sweepRoots: () => [path.join(workdir, 'settings.json')],
        });
    }
    if (enabled.has('stats')) {
        steps.push({
            materialize: (tx, written) => materializeStats({ tx, handle, directories, workdir, written, reuse }),
            sweepRoots: () => [path.join(workdir, 'stats.json')],
        });
    }
    if (enabled.has('worlds')) {
        steps.push({
            materialize: (tx, written) => materializeWorlds({ tx, handle, directories, workdir, written, reuse }),
            sweepRoots: () => [workdirPathFor(workdir, directories, directories.worlds)],
        });
    }
    if (enabled.has('chats')) {
        steps.push({
            materialize: (tx, written) => materializeChats({ tx, handle, directories, workdir, written, reuse }),
            sweepRoots: () => [
                workdirPathFor(workdir, directories, directories.chats),
                workdirPathFor(workdir, directories, directories.groups),
                workdirPathFor(workdir, directories, directories.groupChats),
            ],
        });
    }
    for (const [catId, dirKey] of Object.entries(PRESET_DIR_KEY_BY_CATEGORY)) {
        if (!enabled.has(catId)) continue;
        steps.push({
            materialize: (tx, written) => materializePreset({ tx, handle, directories, workdir, written, reuse, dirKey, engine }),
            sweepRoots: () => [workdirPathFor(workdir, directories, directories[dirKey])],
        });
    }
    for (const [catId, bucket] of Object.entries(NAMED_DOC_BUCKET_BY_CATEGORY)) {
        if (!enabled.has(catId)) continue;
        steps.push({
            materialize: (tx, written) => materializeNamedDoc({ tx, handle, directories, workdir, written, reuse, bucket }),
            sweepRoots: () => [workdirPathFor(workdir, directories, directories[BUCKET_TO_DIR[bucket]])],
        });
    }
    if (steps.length === 0) return { filesWritten: 0, bytes: 0 };

    const { totals, writtenByStep, planned } = await engine.withTransaction(handle, async (tx) => {
        reuse.planned = new Map();
        const attemptTotals = { filesWritten: 0, bytes: 0 };
        const attemptWritten = [];
        for (const step of steps) {
            const written = new Set();
            const result = await step.materialize(tx, written);
            attemptTotals.filesWritten += result?.filesWritten || 0;
            attemptTotals.bytes += result?.bytes || 0;
            attemptWritten.push(written);
        }
        return { totals: attemptTotals, writtenByStep: attemptWritten, planned: [...reuse.planned.values()] };
    });

    await assertDistinctFsDestinations({ boundary, destinations: planned.map(entry => ({ treePath: relUnder(workdir, entry.absPath), absolutePath: entry.absPath, logicalIdentity: relUnder(workdir, entry.absPath), kind: 'file' })), operation: 'materialize records' });
    for (const { absPath, bytes } of planned) {
        assertSafeProjectionPath(absPath, boundary);
        fs.mkdirSync(path.dirname(absPath), { recursive: true });
        fs.writeFileSync(absPath, bytes);
    }

    // Each category sweeps only its own roots against its own written set.
    // Roots that resolve outside the workdir are skipped so a misconfigured
    // directory entry never turns the sweep into a live-tree deletion.
    const resolvedWorkdir = path.resolve(workdir);
    steps.forEach((step, index) => {
        for (const root of step.sweepRoots()) {
            const resolved = path.resolve(root);
            if (resolved !== resolvedWorkdir && !resolved.startsWith(resolvedWorkdir + path.sep)) continue;
            sweepWorkdirRoot(root, writtenByStep[index], boundary);
        }
    });
    return totals;
}

/**
 * Project the workdir tree back into the SQL engine. No-op for
 * `engine.kind === 'fs'`. Per-category transaction, wrapped in a
 * read-only-bypass so writes go through even if the sync orchestrator has
 * frozen the engine's HTTP surface mid-sync.
 *
 * Records present in the engine but missing from the workdir are deleted —
 * deletes propagate through sync the same way other edits do.
 *
 * @param {object} opts
 * @param {string} opts.handle
 * @param {object} opts.directories
 * @param {string[]} opts.categories
 * @param {string} opts.workdir
 * @param {{ kind: string, withTransaction: Function }} opts.engine
 * @returns {Promise<{recordsWritten: number, recordsDeleted: number}>}
 */
export async function dematerializeWorkdirIntoUserData({
    handle, directories, categories, workdir, engine,
}) {
    if (!engine || typeof engine.withTransaction !== 'function') {
        throw new TypeError('dematerializeWorkdirIntoUserData: engine.withTransaction required');
    }
    if (engine.kind === 'fs') return { recordsWritten: 0, recordsDeleted: 0 };

    const enabled = new Set(categories || []);
    const stats = { recordsWritten: 0, recordsDeleted: 0 };

    return withReadOnlyBypass(async () => {
        if (enabled.has('settings')) {
            await engine.withTransaction(handle, (tx) =>
                dematerializeSettings({ tx, handle, directories, workdir, stats }));
        }
        if (enabled.has('stats')) {
            await engine.withTransaction(handle, (tx) =>
                dematerializeStats({ tx, handle, directories, workdir, stats }));
        }
        if (enabled.has('worlds')) {
            await engine.withTransaction(handle, (tx) =>
                dematerializeWorlds({ tx, handle, directories, workdir, stats }));
        }
        if (enabled.has('chats')) {
            await engine.withTransaction(handle, (tx) =>
                dematerializeChats({ tx, handle, directories, workdir, stats }));
        }
        for (const [catId, dirKey] of Object.entries(PRESET_DIR_KEY_BY_CATEGORY)) {
            if (!enabled.has(catId)) continue;
            await engine.withTransaction(handle, (tx) =>
                dematerializePreset({ tx, handle, directories, workdir, stats, dirKey }));
        }
        for (const [catId, bucket] of Object.entries(NAMED_DOC_BUCKET_BY_CATEGORY)) {
            if (!enabled.has(catId)) continue;
            await engine.withTransaction(handle, (tx) =>
                dematerializeNamedDoc({ tx, handle, directories, workdir, stats, bucket }));
        }
        return stats;
    });
}
