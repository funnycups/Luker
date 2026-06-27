// Comprehensive parity verifier for the real-data cross-mode recovery e2e specs.
//
// The 12 fabricated cross-mode specs only assert that ONE seeded chat row
// makes it across. That's enough to prove the wiring, but tells us nothing
// about whether every category of real user data round-trips.
//
// This verifier reads BOTH the source dataRoot (whatever engine the user
// runs) AND the destination dataRoot (whichever engine we restored into)
// and produces a per-category diff:
//
//   { settings: {missing: [...], changed: [...], extra: [...]}, ... }
//
// The spec asserts the diff is empty for every category that the backup
// ZIP carries.  Categories outside the backup scope (e.g. `card-apps`,
// chat_backups, _macros_cache) are deliberately ignored — they're not in
// the contract.
//
// Reads are done out-of-band against the on-disk files / engine files,
// not via the live server, so the verifier is independent from the
// migration code under test.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

// ----- low-level fingerprint helpers ----------------------------------

/** Stable hash over a JSON-safe value. Object keys sorted recursively. */
function hashJson(value) {
    const canonical = canonicalize(value);
    return createHash('sha256').update(canonical).digest('hex');
}

/** Recursively sort object keys so semantically-equal docs hash equal. */
function canonicalize(v) {
    if (Array.isArray(v)) return '[' + v.map(canonicalize).join(',') + ']';
    if (v && typeof v === 'object') {
        const keys = Object.keys(v).sort();
        return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalize(v[k])).join(',') + '}';
    }
    return JSON.stringify(v);
}

/** Hash a file's bytes (for fs-tree categories like characters / extensions). */
function hashFile(filePath) {
    const buf = readFileSync(filePath);
    return createHash('sha256').update(buf).digest('hex');
}

// ----- source enumeration ---------------------------------------------

/**
 * Read a sqlite dataRoot's entire engine state into a normalized shape.
 *
 * @param {string} dataRoot
 * @param {string} handle  (default-user)
 * @returns {Promise<EngineSnapshot>}
 */
async function readSqliteEngine(dataRoot, handle) {
    const Database = (await import('better-sqlite3')).default;
    const dbPath = resolve(dataRoot, handle, 'luker-storage.sqlite');
    if (!existsSync(dbPath)) return emptyEngineSnapshot();
    const db = new Database(dbPath, { readonly: true });
    try {
        const snap = emptyEngineSnapshot();

        for (const r of db.prepare('SELECT char_dir, name, is_group, group_id, doc FROM chats WHERE handle = ?').all(handle)) {
            const id = chatId(r.char_dir, r.name, r.is_group, r.group_id);
            const doc = parseJsonOrNull(r.doc);
            if (doc) snap.chats[id] = chatFingerprint(doc);
        }
        for (const r of db.prepare('SELECT char_dir, name, is_group, group_id, namespace, doc FROM chat_states WHERE handle = ?').all(handle)) {
            const id = chatId(r.char_dir, r.name, r.is_group, r.group_id) + '|' + r.namespace;
            const doc = parseJsonOrNull(r.doc);
            if (doc) snap.chat_states[id] = hashJson(doc);
        }
        for (const r of db.prepare('SELECT doc FROM settings WHERE handle = ?').all(handle)) {
            const doc = parseJsonOrNull(r.doc);
            if (doc) snap.settings[handle] = hashJson(doc);
        }
        for (const r of db.prepare('SELECT dir_key, name, doc FROM presets WHERE handle = ?').all(handle)) {
            const id = r.dir_key + '|' + r.name;
            const doc = parseJsonOrNull(r.doc);
            if (doc) snap.presets[id] = hashJson(doc);
        }
        for (const r of db.prepare('SELECT dir_key, name, namespace, doc FROM preset_states WHERE handle = ?').all(handle)) {
            const id = r.dir_key + '|' + r.name + '|' + r.namespace;
            const doc = parseJsonOrNull(r.doc);
            if (doc) snap.preset_states[id] = hashJson(doc);
        }
        for (const r of db.prepare('SELECT name, doc FROM worlds WHERE handle = ?').all(handle)) {
            const doc = parseJsonOrNull(r.doc);
            if (doc) snap.worlds[r.name] = hashJson(doc);
        }
        for (const r of db.prepare('SELECT bucket, name, doc FROM named_docs WHERE handle = ?').all(handle)) {
            const id = r.bucket + '|' + r.name;
            const doc = parseJsonOrNull(r.doc);
            if (doc) snap.named_docs[id] = hashJson(doc);
        }
        for (const r of db.prepare('SELECT id, doc FROM groups_table WHERE handle = ?').all(handle)) {
            const doc = parseJsonOrNull(r.doc);
            if (doc) snap.groups[r.id] = hashJson(doc);
        }
        for (const r of db.prepare('SELECT doc FROM stats WHERE handle = ?').all(handle)) {
            const doc = parseJsonOrNull(r.doc);
            if (doc) snap.stats[handle] = hashJson(doc);
        }
        return snap;
    } finally {
        db.close();
    }
}

/**
 * Read a fs-mode dataRoot's "engine equivalent" state — every disk file
 * that an fs-mode user keeps in the categories the engine would otherwise
 * hold.  Returns the same EngineSnapshot shape as readSqliteEngine, so
 * the diff is symmetric regardless of which engine is on which side.
 */
function readFsEngine(dataRoot, handle) {
    const userRoot = resolve(dataRoot, handle);
    const snap = emptyEngineSnapshot();
    if (!existsSync(userRoot)) return snap;

    // settings.json
    const settingsPath = resolve(userRoot, 'settings.json');
    if (existsSync(settingsPath)) {
        const doc = parseJsonOrNull(readFileSync(settingsPath, 'utf-8'));
        if (doc) snap.settings[handle] = hashJson(doc);
    }

    // chats: chats/<char>/<name>.jsonl  +  group chats/<groupId>.jsonl
    const chatsDir = resolve(userRoot, 'chats');
    if (existsSync(chatsDir)) {
        for (const cd of readdirSync(chatsDir)) {
            const charDirPath = resolve(chatsDir, cd);
            if (!statSync(charDirPath).isDirectory()) continue;
            // First pass: real .jsonl chats. The sidecar pass below handles
            // state files using the documented `<name>.luker-state.<ns>.json`
            // pattern — they live in the same dir as the parent .jsonl.
            const allEntries = readdirSync(charDirPath);
            const jsonlEntries = allEntries.filter(f => f.endsWith('.jsonl'));
            for (const f of jsonlEntries) {
                const name = f.slice(0, -'.jsonl'.length);
                const chatRecord = parseChatJsonl(resolve(charDirPath, f));
                if (chatRecord) {
                    const id = chatId(cd, name, 0, '');
                    snap.chats[id] = chatFingerprint(chatRecord);
                }
                for (const sidecarFile of allEntries) {
                    const ns = parseSidecarFilename(sidecarFile, name);
                    if (ns === null) continue;
                    const sidecarDoc = parseJsonOrNull(readFileSync(resolve(charDirPath, sidecarFile), 'utf-8'));
                    if (sidecarDoc) {
                        const sid = chatId(cd, name, 0, '') + '|' + ns;
                        snap.chat_states[sid] = hashJson(sidecarDoc);
                    }
                }
            }
        }
    }

    // group chats
    const groupChatsDir = resolve(userRoot, 'group chats');
    if (existsSync(groupChatsDir)) {
        for (const f of readdirSync(groupChatsDir)) {
            const m = f.match(/^(.+)\.jsonl$/);
            if (!m) continue;
            const name = m[1];
            const chatRecord = parseChatJsonl(resolve(groupChatsDir, f));
            if (chatRecord) {
                const id = chatId('', name, 1, name);
                snap.chats[id] = chatFingerprint(chatRecord);
            }
        }
    }

    // presets — every dir in PRESET_FOLDER_BY_API_ID
    const presetDirs = {
        koboldAI_Settings: 'KoboldAI Settings',
        novelAI_Settings: 'NovelAI Settings',
        textGen_Settings: 'TextGen Settings',
        openAI_Settings: 'OpenAI Settings',
        instruct: 'instruct',
        context: 'context',
        sysprompt: 'sysprompt',
        reasoning: 'reasoning',
    };
    for (const [dirKey, dirName] of Object.entries(presetDirs)) {
        const dir = resolve(userRoot, dirName);
        if (!existsSync(dir)) continue;
        const allEntries = readdirSync(dir);
        // Parent preset files: `<name>.json` that do NOT match the sidecar
        // infix pattern (so we don't double-count state sidecars).
        const presetEntries = allEntries.filter(f => f.endsWith('.json') && !f.includes(SIDECAR_INFIX));
        for (const f of presetEntries) {
            const name = f.slice(0, -'.json'.length);
            const doc = parseJsonOrNull(readFileSync(resolve(dir, f), 'utf-8'));
            if (doc) snap.presets[`${dirKey}|${name}`] = hashJson(doc);
            // preset_states sidecars next to the .json
            for (const sidecarFile of allEntries) {
                const ns = parseSidecarFilename(sidecarFile, name);
                if (ns === null) continue;
                const sidecarDoc = parseJsonOrNull(readFileSync(resolve(dir, sidecarFile), 'utf-8'));
                if (sidecarDoc) {
                    snap.preset_states[`${dirKey}|${name}|${ns}`] = hashJson(sidecarDoc);
                }
            }
        }
    }

    // worlds
    const worldsDir = resolve(userRoot, 'worlds');
    if (existsSync(worldsDir)) {
        for (const f of readdirSync(worldsDir)) {
            const m = f.match(/^(.+)\.json$/);
            if (!m) continue;
            const doc = parseJsonOrNull(readFileSync(resolve(worldsDir, f), 'utf-8'));
            if (doc) snap.worlds[m[1]] = hashJson(doc);
        }
    }

    // named_docs (themes / movingUI / quickreplies)
    const namedDocDirs = { themes: 'themes', movingUI: 'movingUI', quickReplies: 'quickreplies' };
    for (const [bucket, dirName] of Object.entries(namedDocDirs)) {
        const dir = resolve(userRoot, dirName);
        if (!existsSync(dir)) continue;
        for (const f of readdirSync(dir)) {
            const m = f.match(/^(.+)\.json$/);
            if (!m) continue;
            const doc = parseJsonOrNull(readFileSync(resolve(dir, f), 'utf-8'));
            if (doc) snap.named_docs[`${bucket}|${m[1]}`] = hashJson(doc);
        }
    }

    // groups
    const groupsDir = resolve(userRoot, 'groups');
    if (existsSync(groupsDir)) {
        for (const f of readdirSync(groupsDir)) {
            const m = f.match(/^(.+)\.json$/);
            if (!m) continue;
            const doc = parseJsonOrNull(readFileSync(resolve(groupsDir, f), 'utf-8'));
            if (doc) snap.groups[m[1]] = hashJson(doc);
        }
    }

    // stats
    const statsPath = resolve(userRoot, 'stats.json');
    if (existsSync(statsPath)) {
        const doc = parseJsonOrNull(readFileSync(statsPath, 'utf-8'));
        if (doc) snap.stats[handle] = hashJson(doc);
    }

    return snap;
}

function emptyEngineSnapshot() {
    return {
        chats: {},
        chat_states: {},
        settings: {},
        presets: {},
        preset_states: {},
        worlds: {},
        named_docs: {},
        groups: {},
        stats: {},
    };
}

function chatId(charDir, name, isGroup, groupId) {
    return `${charDir}|${name}|${isGroup}|${groupId}`;
}

/**
 * Fingerprint a chat record `{header, body}` ignoring fields that are
 * intentionally not preserved across engine round-trips:
 *
 *   - header.chat_metadata.integrity (recomputed from body on write)
 *   - createdAt / updatedAt (file mtime vs row updated_at differ by engine)
 *   - any field the engine intentionally strips
 *
 * The body is hashed as a sequence of canonical message JSONs so message
 * ORDER matters but field ordering inside a message does not.
 */
function chatFingerprint(record) {
    const header = { ...(record.header || {}) };
    const meta = { ...(header.chat_metadata || {}) };
    delete meta.integrity;
    header.chat_metadata = meta;
    const body = Array.isArray(record.body) ? record.body : [];
    return hashJson({ header, body });
}

function parseChatJsonl(filePath) {
    try {
        const raw = readFileSync(filePath, 'utf-8');
        const lines = raw.split('\n').filter(l => l.length > 0);
        if (lines.length === 0) return null;
        const header = JSON.parse(lines[0]);
        const body = lines.slice(1).map(l => JSON.parse(l));
        return { header, body };
    } catch {
        return null;
    }
}

function parseJsonOrNull(raw) {
    if (raw == null) return null;
    if (typeof raw === 'object') return raw;
    try { return JSON.parse(raw); } catch { return null; }
}

// Sidecar filename convention from src/storage/engines/sidecar-naming.js:
//   <base>.luker-state.<namespace>.json
// Chats live as `<name>.jsonl`; presets live as `<name>.json`. The state
// sidecars are written next to the parent file with the infix above.
const SIDECAR_INFIX = '.luker-state.';
const SIDECAR_EXT = '.json';

function parseSidecarFilename(entry, base) {
    const prefix = `${base}${SIDECAR_INFIX}`;
    if (!entry.startsWith(prefix) || !entry.endsWith(SIDECAR_EXT)) return null;
    return entry.slice(prefix.length, entry.length - SIDECAR_EXT.length);
}

// ----- fs-tree category enumeration -----------------------------------

/**
 * Build a fingerprint map for an fs-tree subdirectory.  Walks recursively
 * and hashes file bytes.  Returned keys are paths relative to `rootDir`.
 */
function readFsTreeDir(rootDir) {
    const out = {};
    if (!existsSync(rootDir)) return out;
    walk(rootDir, '', out);
    return out;
}

function walk(absRoot, relPrefix, out) {
    for (const entry of readdirSync(resolve(absRoot, relPrefix))) {
        const abs = resolve(absRoot, relPrefix, entry);
        const rel = relPrefix ? `${relPrefix}/${entry}` : entry;
        let st;
        try { st = statSync(abs); } catch { continue; }
        if (st.isDirectory()) {
            walk(absRoot, rel, out);
            continue;
        }
        if (!st.isFile()) continue;
        out[rel] = hashFile(abs);
    }
}

/** Read every fs-tree category we expect the backup ZIP to round-trip. */
function readFsTreeCategories(dataRoot, handle) {
    const userRoot = resolve(dataRoot, handle);
    return {
        secrets: readSecretsFile(userRoot),
        characters: readFsTreeDir(resolve(userRoot, 'characters')),
        avatars: readFsTreeDir(resolve(userRoot, 'User Avatars')),
        backgrounds: readFsTreeDir(resolve(userRoot, 'backgrounds')),
        assets: readFsTreeDir(resolve(userRoot, 'assets')),
        userFiles: readFsTreeDir(resolve(userRoot, 'user/files')),
        userImages: readFsTreeDir(resolve(userRoot, 'user/images')),
        userWorkflows: readFsTreeDir(resolve(userRoot, 'user/workflows')),
        extensions: readFsTreeDir(resolve(userRoot, 'extensions')),
        vectors: readFsTreeDir(resolve(userRoot, 'vectors')),
    };
}

function readSecretsFile(userRoot) {
    const path = resolve(userRoot, 'secrets.json');
    if (!existsSync(path)) return {};
    const doc = parseJsonOrNull(readFileSync(path, 'utf-8'));
    return doc ? { 'secrets.json': hashJson(doc) } : {};
}

// ----- diff -----------------------------------------------------------

/**
 * Diff two fingerprint maps. Returns lists of items missing on dest,
 * changed (present on both but different hash), and extra (on dest but
 * not on source).
 */
function diffMaps(srcMap, dstMap) {
    const missing = [];
    const changed = [];
    const extra = [];
    for (const k of Object.keys(srcMap)) {
        if (!(k in dstMap)) missing.push(k);
        else if (srcMap[k] !== dstMap[k]) changed.push(k);
    }
    for (const k of Object.keys(dstMap)) {
        if (!(k in srcMap)) extra.push(k);
    }
    missing.sort(); changed.sort(); extra.sort();
    return { missing, changed, extra };
}

// ----- public API -----------------------------------------------------

/**
 * Read a dataRoot in either engine mode into a unified per-category
 * fingerprint snapshot.
 *
 * @param {object} opts
 * @param {string} opts.dataRoot
 * @param {'fs'|'sqlite'|'mysql'|'postgres'} opts.engineMode
 * @param {object|null} [opts.dbConfig]  for mysql/pg: `{mysql:{url}}` etc
 * @param {string} [opts.handle='default-user']
 * @returns {Promise<DataRootSnapshot>}
 */
export async function snapshotDataRoot({ dataRoot, engineMode, dbConfig = null, handle = 'default-user' }) {
    if (!dataRoot) throw new Error('snapshotDataRoot: dataRoot required');
    let engineSnap;
    if (engineMode === 'fs') {
        engineSnap = readFsEngine(dataRoot, handle);
    } else if (engineMode === 'sqlite') {
        engineSnap = await readSqliteEngine(dataRoot, handle);
    } else if (engineMode === 'mysql') {
        engineSnap = await readMysqlEngine(dbConfig, handle);
    } else if (engineMode === 'postgres') {
        engineSnap = await readPostgresEngine(dbConfig, handle);
    } else {
        throw new Error(`snapshotDataRoot: unsupported engineMode "${engineMode}"`);
    }

    const fsTree = readFsTreeCategories(dataRoot, handle);
    return { engine: engineSnap, fsTree };
}

async function readMysqlEngine(dbConfig, handle) {
    const url = dbConfig?.mysql?.url;
    if (!url) throw new Error('readMysqlEngine: missing mysql url');
    const mysql = await import('mysql2/promise');
    const conn = await mysql.createConnection(url);
    try {
        return await readEngineViaSql(handle, async (sql, args) => {
            const [rows] = await conn.query(sql, args);
            return rows;
        });
    } finally {
        await conn.end();
    }
}

async function readPostgresEngine(dbConfig, handle) {
    const url = dbConfig?.postgres?.url;
    if (!url) throw new Error('readPostgresEngine: missing postgres url');
    const { Client } = await import('pg');
    const client = new Client({ connectionString: url });
    await client.connect();
    try {
        // Postgres uses $1 placeholders; translate ? → $1, $2 ...
        return await readEngineViaSql(handle, async (sql, args) => {
            let i = 0;
            const pgSql = sql.replace(/\?/g, () => '$' + (++i));
            const res = await client.query(pgSql, args || []);
            return res.rows;
        });
    } finally {
        await client.end();
    }
}

async function readEngineViaSql(handle, query) {
    const snap = emptyEngineSnapshot();
    for (const r of await query('SELECT char_dir, name, is_group, group_id, doc FROM chats WHERE handle = ?', [handle])) {
        const id = chatId(r.char_dir, r.name, r.is_group, r.group_id);
        const doc = parseJsonOrNull(r.doc);
        if (doc) snap.chats[id] = chatFingerprint(doc);
    }
    for (const r of await query('SELECT char_dir, name, is_group, group_id, namespace, doc FROM chat_states WHERE handle = ?', [handle])) {
        const id = chatId(r.char_dir, r.name, r.is_group, r.group_id) + '|' + r.namespace;
        const doc = parseJsonOrNull(r.doc);
        if (doc) snap.chat_states[id] = hashJson(doc);
    }
    for (const r of await query('SELECT doc FROM settings WHERE handle = ?', [handle])) {
        const doc = parseJsonOrNull(r.doc);
        if (doc) snap.settings[handle] = hashJson(doc);
    }
    for (const r of await query('SELECT dir_key, name, doc FROM presets WHERE handle = ?', [handle])) {
        const doc = parseJsonOrNull(r.doc);
        if (doc) snap.presets[r.dir_key + '|' + r.name] = hashJson(doc);
    }
    for (const r of await query('SELECT dir_key, name, namespace, doc FROM preset_states WHERE handle = ?', [handle])) {
        const doc = parseJsonOrNull(r.doc);
        if (doc) snap.preset_states[r.dir_key + '|' + r.name + '|' + r.namespace] = hashJson(doc);
    }
    for (const r of await query('SELECT name, doc FROM worlds WHERE handle = ?', [handle])) {
        const doc = parseJsonOrNull(r.doc);
        if (doc) snap.worlds[r.name] = hashJson(doc);
    }
    for (const r of await query('SELECT bucket, name, doc FROM named_docs WHERE handle = ?', [handle])) {
        const doc = parseJsonOrNull(r.doc);
        if (doc) snap.named_docs[r.bucket + '|' + r.name] = hashJson(doc);
    }
    for (const r of await query('SELECT id, doc FROM groups_table WHERE handle = ?', [handle])) {
        const doc = parseJsonOrNull(r.doc);
        if (doc) snap.groups[r.id] = hashJson(doc);
    }
    for (const r of await query('SELECT doc FROM stats WHERE handle = ?', [handle])) {
        const doc = parseJsonOrNull(r.doc);
        if (doc) snap.stats[handle] = hashJson(doc);
    }
    return snap;
}

/**
 * Compare a source snapshot (BEFORE backup) against a dest snapshot (AFTER
 * restore) and return a structured per-category diff.
 *
 * Categories are aligned 1:1 — any item in source that's missing or
 * changed on dest is a parity failure.  Items extra on dest (e.g. the
 * dest's bootstrap-seeded default themes) are reported separately so the
 * spec can decide whether to tolerate them.
 *
 * @param {DataRootSnapshot} src
 * @param {DataRootSnapshot} dst
 * @returns {ParityReport}
 */
export function compareSnapshots(src, dst) {
    const report = { engine: {}, fsTree: {} };
    for (const cat of Object.keys(src.engine)) {
        report.engine[cat] = diffMaps(src.engine[cat], dst.engine[cat] || {});
    }
    for (const cat of Object.keys(src.fsTree)) {
        report.fsTree[cat] = diffMaps(src.fsTree[cat], dst.fsTree[cat] || {});
    }
    return report;
}

/**
 * Boolean: any missing OR changed item, on any category? "extra" items
 * are not a fault — the dest may legitimately ship pre-seeded defaults.
 */
export function hasParityFailures(report) {
    for (const group of [report.engine, report.fsTree]) {
        for (const cat of Object.keys(group)) {
            const d = group[cat];
            if (d.missing.length > 0 || d.changed.length > 0) return true;
        }
    }
    return false;
}

/**
 * Render a human-readable summary of a parity report — used in test
 * failure messages so the developer can see exactly which file or row
 * did not round-trip.
 */
export function formatParityReport(report, { maxPerCategory = 20 } = {}) {
    const lines = [];
    const dumpGroup = (label, group) => {
        for (const cat of Object.keys(group).sort()) {
            const d = group[cat];
            if (d.missing.length === 0 && d.changed.length === 0 && d.extra.length === 0) continue;
            lines.push(`${label}/${cat}: ${d.missing.length} missing, ${d.changed.length} changed, ${d.extra.length} extra`);
            const showList = (kind, items) => {
                if (items.length === 0) return;
                const truncated = items.length > maxPerCategory;
                const shown = truncated ? items.slice(0, maxPerCategory) : items;
                for (const it of shown) lines.push(`    ${kind}: ${it}`);
                if (truncated) lines.push(`    ... ${items.length - maxPerCategory} more ${kind}`);
            };
            showList('missing', d.missing);
            showList('changed', d.changed);
            showList('extra  ', d.extra);
        }
    };
    dumpGroup('engine', report.engine);
    dumpGroup('fsTree', report.fsTree);
    if (lines.length === 0) return 'parity OK — every category matches';
    return lines.join('\n');
}

/**
 * @typedef {Object} EngineSnapshot
 * @property {Record<string,string>} chats
 * @property {Record<string,string>} chat_states
 * @property {Record<string,string>} settings
 * @property {Record<string,string>} presets
 * @property {Record<string,string>} preset_states
 * @property {Record<string,string>} worlds
 * @property {Record<string,string>} named_docs
 * @property {Record<string,string>} groups
 * @property {Record<string,string>} stats
 */

/**
 * @typedef {Object} DataRootSnapshot
 * @property {EngineSnapshot} engine
 * @property {Record<string, Record<string,string>>} fsTree
 */

/**
 * @typedef {Object} CategoryDiff
 * @property {string[]} missing
 * @property {string[]} changed
 * @property {string[]} extra
 */

/**
 * @typedef {Object} ParityReport
 * @property {Record<string, CategoryDiff>} engine
 * @property {Record<string, CategoryDiff>} fsTree
 */
