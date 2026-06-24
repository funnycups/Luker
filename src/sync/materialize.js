/**
 * Engine-agnostic projection between per-user repository data and an on-disk
 * file tree shaped exactly like the FS engine's live root. The shadow git
 * workdir that drives LAN-sync conflict resolution wants a single canonical
 * format; this module makes the SQL engines (sqlite/mysql/postgres) speak it
 * without forking the snapshot walker.
 *
 * In `fs` mode the live tree already IS that format, so both directions are
 * no-ops and the orchestrator skips the call.
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

import { PRESET_FOLDER_BY_API_ID } from '../storage/repositories/preset-repo.js';
import { BUCKET_TO_DIR } from '../storage/repositories/named-doc-repo.js';
import { withReadOnlyBypass } from '../storage/read-only-mode.js';
import { buildSidecarFilename, parseSidecarFilename, SIDECAR_INFIX } from '../storage/engines/sidecar-naming.js';

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

function toPosix(p) {
    return p.split(path.sep).join('/');
}

function relUnder(root, abs) {
    return toPosix(path.relative(root, abs));
}

function writeJsonFile(absPath, value) {
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    const json = JSON.stringify(value, null, 4);
    fs.writeFileSync(absPath, json);
    return Buffer.byteLength(json, 'utf-8');
}

function writeChatJsonl(absPath, header, body) {
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    const lines = [JSON.stringify(header)];
    for (const m of body || []) lines.push(JSON.stringify(m));
    const text = lines.join('\n') + '\n';
    fs.writeFileSync(absPath, text);
    return Buffer.byteLength(text, 'utf-8');
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
 * Reject workdir entry names that could escape their parent directory or
 * surface hidden host files. A peer can push any tree shape they like over
 * git; we treat raw `readdirSync` output as untrusted input.
 *
 * Skips: empty, leading-dot (covers `.`, `..`, `.git`, `.DS_Store`, dotfiles),
 * any path separator (`/` or `\`), and any segment containing `..`.
 */
function isUnsafeEntryName(entry) {
    if (typeof entry !== 'string' || entry.length === 0) return true;
    if (entry.startsWith('.')) return true;
    if (entry.includes('/') || entry.includes('\\')) return true;
    if (entry.includes('..')) return true;
    return false;
}

// --- materializers (per category) -----------------------------------------

async function materializeSettings({ tx, handle, directories, workdir }) {
    const rec = await tx.getResource({ kind: 'settings', handle });
    if (rec == null) return { filesWritten: 0, bytes: 0 };
    const out = path.join(workdir, 'settings.json');
    return { filesWritten: 1, bytes: writeJsonFile(out, rec) };
}

async function materializeStats({ tx, handle, directories, workdir }) {
    const rec = await tx.getResource({ kind: 'stats', handle });
    if (rec == null) return { filesWritten: 0, bytes: 0 };
    const out = path.join(workdir, 'stats.json');
    return { filesWritten: 1, bytes: writeJsonFile(out, rec) };
}

async function materializeWorlds({ tx, handle, directories, workdir }) {
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
        bytes += writeJsonFile(abs, doc);
        filesWritten++;
    }
    return { filesWritten, bytes };
}

async function materializePreset({ tx, handle, directories, workdir, dirKey }) {
    const apiId = PRESET_API_BY_DIR_KEY.get(dirKey);
    if (!apiId) throw new Error(`materialize: unknown preset dirKey ${dirKey}`);
    let filesWritten = 0;
    let bytes = 0;
    const folder = directories[dirKey];
    if (typeof folder !== 'string') {
        throw new Error(`materialize: directories.${dirKey} missing`);
    }
    const entries = await tx.listResources({ kind: 'preset', handle, apiId, dirKey });
    for (const entry of entries) {
        const name = entry?.key?.name;
        if (!name) continue;
        const key = { kind: 'preset', handle, dirKey, name };
        const doc = await tx.getResource(key);
        if (doc == null) continue;
        const rel = relUnder(directories.root, path.join(folder, `${name}${PRESET_EXT}`));
        bytes += writeJsonFile(path.join(workdir, rel), doc);
        filesWritten++;
        const namespaces = await tx.listPresetStateNamespaces(key);
        for (const ns of namespaces) {
            const stateDoc = await tx.getPresetState(key, ns);
            if (stateDoc == null) continue;
            const sidecarRel = relUnder(
                directories.root,
                path.join(folder, buildSidecarFilename(name, ns)),
            );
            bytes += writeJsonFile(path.join(workdir, sidecarRel), stateDoc);
            filesWritten++;
        }
    }
    return { filesWritten, bytes };
}

async function materializeNamedDoc({ tx, handle, directories, workdir, bucket }) {
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
        bytes += writeJsonFile(path.join(workdir, rel), doc);
        filesWritten++;
    }
    return { filesWritten, bytes };
}

async function materializeChats({ tx, handle, directories, workdir }) {
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
        bytes += writeChatJsonl(abs, header, chat.body);
        filesWritten++;
        const namespaces = await tx.listChatStateNamespaces(key);
        for (const ns of namespaces) {
            const stateDoc = await tx.getChatState(key, ns);
            if (stateDoc == null) continue;
            const sidecarAbs = path.join(workdir, relUnder(
                directories.root,
                path.join(directories.chats, k.charDir, buildSidecarFilename(k.name, ns)),
            ));
            bytes += writeJsonFile(sidecarAbs, stateDoc);
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
        bytes += writeJsonFile(groupAbs, groupDoc);
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
            bytes += writeChatJsonl(abs, header, chat.body);
            filesWritten++;
            const namespaces = await tx.listChatStateNamespaces(key);
            for (const ns of namespaces) {
                const stateDoc = await tx.getChatState(key, ns);
                if (stateDoc == null) continue;
                const sidecarAbs = path.join(workdir, relUnder(
                    directories.root,
                    path.join(directories.groupChats, buildSidecarFilename(chatId, ns)),
                ));
                bytes += writeJsonFile(sidecarAbs, stateDoc);
                filesWritten++;
            }
        }
    }

    return { filesWritten, bytes };
}

// --- enumerate (pure) ------------------------------------------------------

/**
 * Set of POSIX paths (relative to `directories.root`) that the SQL-mode
 * materializer can write under the given enabled categories. Used by the
 * orchestrator's pre-write sweep to drop stale workdir entries before
 * re-materializing — anything inside one of these category roots that
 * isn't in the set after the latest run is a delete and should be unlinked
 * so the snapshot walker doesn't carry it forward.
 *
 * Pure (no I/O) for category roots themselves. For categories whose layout
 * is keyed off on-disk names (e.g. one file per chat), we walk the existing
 * live tree to enumerate the leaf names — this lets the caller pass the
 * pre-materialize workdir state and get back the set of paths a subsequent
 * materialize call WILL write.
 */
export function enumerateMaterializedRelPaths({ directories, categories }) {
    const out = new Set();
    if (!directories || typeof directories.root !== 'string') {
        throw new TypeError('enumerateMaterializedRelPaths: directories.root required');
    }
    const enabled = new Set(categories || []);
    const addRel = (abs) => out.add(relUnder(directories.root, abs));
    const addDirContents = (dir, suffix) => {
        if (typeof dir !== 'string') return;
        for (const entry of listDirSafe(dir)) {
            if (isUnsafeEntryName(entry)) continue;
            if (suffix && !entry.endsWith(suffix)) continue;
            addRel(path.join(dir, entry));
        }
    };

    if (enabled.has('settings')) addRel(path.join(directories.root, 'settings.json'));
    if (enabled.has('stats')) addRel(path.join(directories.root, 'stats.json'));

    if (enabled.has('worlds')) {
        addDirContents(directories.worlds, '.json');
    }

    if (enabled.has('chats')) {
        // per-character chats: chats/<charDir>/*
        const chatsDir = directories.chats;
        for (const charDir of listDirSafe(chatsDir)) {
            if (isUnsafeEntryName(charDir)) continue;
            const charPath = path.join(chatsDir, charDir);
            try {
                if (!fs.statSync(charPath).isDirectory()) continue;
            } catch { continue; }
            for (const entry of listDirSafe(charPath)) {
                if (isUnsafeEntryName(entry)) continue;
                addRel(path.join(charPath, entry));
            }
        }
        addDirContents(directories.groups, '.json');
        for (const entry of listDirSafe(directories.groupChats)) {
            if (isUnsafeEntryName(entry)) continue;
            addRel(path.join(directories.groupChats, entry));
        }
    }

    for (const [catId, dirKey] of Object.entries(PRESET_DIR_KEY_BY_CATEGORY)) {
        if (!enabled.has(catId)) continue;
        addDirContents(directories[dirKey], '.json');
    }

    for (const [catId, bucket] of Object.entries(NAMED_DOC_BUCKET_BY_CATEGORY)) {
        if (!enabled.has(catId)) continue;
        addDirContents(directories[BUCKET_TO_DIR[bucket]], '.json');
    }

    return out;
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

    const presentNames = new Set();
    const presetEntries = [];
    for (const entry of listDirSafe(folderAbs)) {
        if (isUnsafeEntryName(entry)) continue;
        if (!entry.endsWith(PRESET_EXT)) continue;
        // Skip sidecars — same .json suffix but contain SIDECAR_INFIX.
        if (entry.includes(SIDECAR_INFIX)) continue;
        const name = entry.slice(0, -PRESET_EXT.length);
        presentNames.add(name);
        presetEntries.push({ name, abs: path.join(folderAbs, entry) });
    }

    for (const { name, abs } of presetEntries) {
        const doc = readJsonFile(abs);
        if (doc == null) continue;
        await tx.putResource({ kind: 'preset', handle, dirKey, name }, { doc });
        stats.recordsWritten++;
        // Sidecars for this preset
        const sidecars = listSidecarsForBase(folderAbs, name);
        for (const [ns, sidecarAbs] of sidecars) {
            const stateDoc = readJsonFile(sidecarAbs);
            if (stateDoc == null) continue;
            await tx.putPresetState({ kind: 'preset', handle, dirKey, name }, ns, stateDoc);
            stats.recordsWritten++;
        }
    }

    // Delete presets no longer present (cascades sidecars in sqlite via delete handler).
    const existing = await tx.listResources({ kind: 'preset', handle, apiId, dirKey });
    for (const e of existing) {
        const name = e?.key?.name;
        if (name && !presentNames.has(name)) {
            await tx.deleteResource({ kind: 'preset', handle, dirKey, name });
            stats.recordsDeleted++;
        }
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
 * Project the SQL engine's per-user payload into a workdir tree shaped like
 * the FS engine's live root. No-op for `engine.kind === 'fs'` because that
 * tree already exists on disk.
 *
 * One transaction per category for the read path, so each category's
 * enumeration sees a consistent snapshot (BEGIN IMMEDIATE on sqlite;
 * REPEATABLE READ on mysql/postgres).
 *
 * @param {object} opts
 * @param {string} opts.handle
 * @param {object} opts.directories
 * @param {string[]} opts.categories
 * @param {string} opts.workdir
 * @param {{ kind: string, withTransaction: Function }} opts.engine
 * @returns {Promise<{filesWritten: number, bytes: number}>}
 */
export async function materializeUserDataIntoWorkdir({
    handle, directories, categories, workdir, engine,
}) {
    if (!engine || typeof engine.withTransaction !== 'function') {
        throw new TypeError('materializeUserDataIntoWorkdir: engine.withTransaction required');
    }
    if (engine.kind === 'fs') return { filesWritten: 0, bytes: 0 };

    const enabled = new Set(categories || []);
    const totals = { filesWritten: 0, bytes: 0 };
    const accumulate = (r) => {
        if (!r) return;
        totals.filesWritten += r.filesWritten || 0;
        totals.bytes += r.bytes || 0;
    };

    fs.mkdirSync(workdir, { recursive: true });

    if (enabled.has('settings')) {
        const r = await engine.withTransaction(handle, (tx) =>
            materializeSettings({ tx, handle, directories, workdir }));
        accumulate(r);
    }
    if (enabled.has('stats')) {
        const r = await engine.withTransaction(handle, (tx) =>
            materializeStats({ tx, handle, directories, workdir }));
        accumulate(r);
    }
    if (enabled.has('worlds')) {
        const r = await engine.withTransaction(handle, (tx) =>
            materializeWorlds({ tx, handle, directories, workdir }));
        accumulate(r);
    }
    if (enabled.has('chats')) {
        const r = await engine.withTransaction(handle, (tx) =>
            materializeChats({ tx, handle, directories, workdir }));
        accumulate(r);
    }
    for (const [catId, dirKey] of Object.entries(PRESET_DIR_KEY_BY_CATEGORY)) {
        if (!enabled.has(catId)) continue;
        const r = await engine.withTransaction(handle, (tx) =>
            materializePreset({ tx, handle, directories, workdir, dirKey }));
        accumulate(r);
    }
    for (const [catId, bucket] of Object.entries(NAMED_DOC_BUCKET_BY_CATEGORY)) {
        if (!enabled.has(catId)) continue;
        const r = await engine.withTransaction(handle, (tx) =>
            materializeNamedDoc({ tx, handle, directories, workdir, bucket }));
        accumulate(r);
    }

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
