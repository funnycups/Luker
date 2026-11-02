import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import _ from 'lodash';
import sanitizeFilename from 'sanitize-filename';
import { sync as writeFileAtomic } from 'write-file-atomic';

import { buildSidecarFilename, SIDECAR_INFIX, SIDECAR_EXT } from './sidecar-naming.js';
import { PRESET_FOLDER_BY_API_ID } from '../repositories/preset-repo.js';
import { BUCKET_TO_DIR } from '../repositories/named-doc-repo.js';
import { assertSafeRepoNameShape } from '../name-validation.js';
import { normalizeLookupText } from '../../util.js';
import { encodePresetRecordRelativePath, presetRecordIdentity } from '../preset-paths.js';
import { readPresetInventory, selectPresetEntry, readPresetEntry } from '../preset-inventory.js';
import { assertConfinedPath } from '../path-confinement.js';
import { assertDistinctFsDestinations } from '../path-identity.js';
import { ConflictError } from '../errors.js';
import { chatHeaderWithIntegrity, parseChatJson } from './chat-record.js';
import { STAGING_PREFIX } from '../../sync/staging.js';
import { failpoint, FAILPOINTS } from '../../sync/pipeline/failpoints.js';
import { invalidateCurrentJsonFile, readCurrentJsonFile } from './current-json-file.js';
import { jsonTypeOf } from './json-value.js';

export class FsTransaction {
    constructor({ directoriesByHandle }) {
        this._directoriesByHandle = directoriesByHandle;
        this._handlers = new Map();
        registerChatHandler(this);
        registerSettingsHandler(this);
        registerPresetHandler(this);
        registerWorldInfoHandler(this);
        registerNamedDocHandler(this);
        registerGroupHandler(this);
        registerStatsHandler(this);
    }

    _h(kind, method) {
        const h = this._handlers.get(kind);
        if (!h) throw new Error(`FsTransaction.${method}: unsupported kind ${kind}`);
        return h;
    }

    async getResource(key) {
        return this._h(key.kind, 'getResource').get(key);
    }

    async putResource(key, record) {
        return this._h(key.kind, 'putResource').put(key, record);
    }

    async deleteResource(key) {
        return this._h(key.kind, 'deleteResource').delete(key);
    }

    async listResources(filter) {
        return this._h(filter.kind, 'listResources').list(filter);
    }

    async putResourceIfMatch(key, expectedIntegrity, record) {
        if (key.kind === 'chat' && expectedIntegrity === null) {
            return { updated: this._h('chat', 'putResourceIfMatch').put(key, record, { ifAbsent: true }) };
        }
        const existing = await this.getResource(key);
        if (expectedIntegrity === null) {
            if (existing !== null) return { updated: false };
        } else {
            if (existing === null) return { updated: false };
            if (existing.integrity !== expectedIntegrity) return { updated: false };
        }
        await this.putResource(key, record);
        return { updated: true };
    }

    async hasChatResource(chatKey) {
        return this._h(chatKey.kind, 'hasChatResource').has(chatKey);
    }

    async captureChatMove(key) {
        return this._h('chat', 'captureChatMove').captureMove(key);
    }

    async publishChatMove(key, snapshot) {
        return this._h('chat', 'publishChatMove').publishMove(key, snapshot);
    }

    async deleteChatMoveSource(snapshot) {
        return this._h('chat', 'deleteChatMoveSource').deleteMoveSource(snapshot);
    }

    async getChatState(chatKey, namespace, options) {
        return this._h(chatKey.kind, 'getChatState').getSidecar(chatKey, namespace, options);
    }

    async putChatState(chatKey, namespace, doc, options) {
        return this._h(chatKey.kind, 'putChatState').putSidecar(chatKey, namespace, doc, options);
    }

    async deleteChatState(chatKey, namespace) {
        return this._h(chatKey.kind, 'deleteChatState').deleteSidecar(chatKey, namespace);
    }

    async listChatStateNamespaces(chatKey) {
        return this._h(chatKey.kind, 'listChatStateNamespaces').listSidecarNamespaces(chatKey);
    }

    async getPresetState(presetKey, namespace) {
        return this._h(presetKey.kind, 'getPresetState').getPresetSidecar(presetKey, namespace);
    }

    async putPresetState(presetKey, namespace, doc) {
        return this._h(presetKey.kind, 'putPresetState').putPresetSidecar(presetKey, namespace, doc);
    }

    async deletePresetState(presetKey, namespace) {
        return this._h(presetKey.kind, 'deletePresetState').deletePresetSidecar(presetKey, namespace);
    }

    async listPresetStateNamespaces(presetKey) {
        return this._h(presetKey.kind, 'listPresetStateNamespaces').listPresetSidecarNamespaces(presetKey);
    }

    async listPresetStateRecords(filter) {
        return this._h('preset', 'listPresetStateRecords').listPresetStateRecords(filter);
    }
}

function registerChatHandler(tx) {
    const chatFilePath = (key) => {
        const dirs = tx._directoriesByHandle(key.handle);
        if (key.isGroup) {
            return path.join(dirs.groupChats, `${key.groupId ?? key.name}.jsonl`);
        }
        return path.join(dirs.chats, key.charDir, `${key.name}.jsonl`);
    };

    const sidecarPath = (key, ns) => {
        const file = chatFilePath(key);
        return path.join(path.dirname(file), buildSidecarFilename(path.basename(file, '.jsonl'), ns));
    };

    const confinedParent = (key, file) => assertConfinedPath({ boundary: tx._directoriesByHandle(key.handle).root, absolutePath: path.dirname(file) });
    const statEntry = (key, file) => {
        confinedParent(key, file);
        try { return fs.lstatSync(file); } catch (error) {
            if (error.code === 'ENOENT') return null;
            throw new Error(`Cannot inspect chat entry at ${file}: ${error.code}`);
        }
    };
    const readOwned = (key, file) => {
        const entry = statEntry(key, file);
        if (entry === null) return null;
        if (!entry.isFile()) throw new Error(`Unsafe chat entry at ${file}: expected a regular file without symbolic links`);
        let fd;
        try {
            fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
            const stat = fs.fstatSync(fd);
            if (!stat.isFile()) throw new Error('nonregular entry');
            const bytes = fs.readFileSync(fd);
            return { raw: bytes.toString('utf8'), bytes, stat };
        } catch (error) {
            throw new Error(`Cannot read owned chat entry at ${file}: ${error.code ?? 'nonregular entry'}`);
        } finally {
            if (fd !== undefined) fs.closeSync(fd);
        }
    };
    // Publish a complete owned file without replacing a late-arriving entry.
    const createOnly = (key, file, content, updatedAt, { requireEmptyState = false } = {}) => {
        confinedParent(key, file);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const temporary = path.join(path.dirname(file), `${STAGING_PREFIX}chat-create-${randomUUID()}`);
        const fd = fs.openSync(temporary, 'wx');
        try {
            fs.writeFileSync(fd, content);
            fs.fsyncSync(fd);
            if (typeof updatedAt === 'number' && Number.isFinite(updatedAt)) fs.utimesSync(temporary, updatedAt / 1000, updatedAt / 1000);
            failpoint(FAILPOINTS.CHAT_PUBLICATION_BEFORE_LINK);
            // State writers and this publication are synchronous in the server.
            // Keep the complete namespace check and parent link in one local epoch.
            if (requireEmptyState && listNamespaces(key).length > 0) return false;
            try { fs.linkSync(temporary, file); } catch (error) {
                if (error.code === 'EEXIST') return false;
                throw error;
            }
            return true;
        } finally {
            try { fs.closeSync(fd); } finally { fs.unlinkSync(temporary); }
        }
    };

    const listNamespaces = (key) => {
        const dir = path.dirname(chatFilePath(key));
        confinedParent(key, path.join(dir, 'entry'));
        let entries;
        try { entries = fs.readdirSync(dir); } catch (error) {
            if (error.code === 'ENOENT') return [];
            throw new Error(`Cannot list chat state at ${dir}: ${error.code}`);
        }
        const out = new Set();
        for (const entry of entries) {
            // Separator offsets propose namespaces without requiring literal base,
            // infix or suffix spelling. A selected directory entry owns a namespace;
            // independent hard links must not introduce aliases of another entry.
            for (let index = entry.indexOf('.'); index >= 0; index = entry.indexOf('.', index + 1)) {
                if (index + SIDECAR_INFIX.length > entry.length - SIDECAR_EXT.length) break;
                const namespace = entry.slice(index + SIDECAR_INFIX.length, -SIDECAR_EXT.length);
                const candidatePath = sidecarPath(key, namespace);
                let candidate;
                try { candidate = fs.lstatSync(candidatePath); } catch (error) {
                    // An unrepresentable proposed name cannot identify this entry.
                    if (error.code === 'ENOENT' || error.code === 'ENAMETOOLONG') continue;
                    throw new Error(`Cannot inspect chat state candidate at ${candidatePath}: ${error.code}`);
                }
                const actual = statEntry(key, path.join(dir, entry));
                if (actual && candidate.dev === actual.dev && candidate.ino === actual.ino) {
                    // Unsafe links remain inventoried for explicit read/occupancy
                    // refusal. Regular entries use native paths, not inode deduplication.
                    if (candidate.isSymbolicLink() || fs.realpathSync.native(candidatePath) === fs.realpathSync.native(path.join(dir, entry))) out.add(namespace);
                }
            }
        }
        return [...out];
    };

    const readParent = key => {
        const filePath = chatFilePath(key);
        const owned = readOwned(key, filePath);
        if (owned === null) return null;
        const { raw, stat } = owned;
        const lines = raw.split('\n').filter((l) => l.length > 0);
        if (lines.length === 0) throw new Error(`Unreadable chat document at ${filePath}: empty file`);
        const header = parseChatJson(lines[0], `${filePath} line 1`);
        if (!header || typeof header !== 'object' || Array.isArray(header)) throw new Error(`Unreadable chat header at ${filePath} line 1: expected an object`);
        const body = [];
        for (const [index, line] of lines.slice(1).entries()) body.push(parseChatJson(line, `${filePath} line ${index + 2}`));
        return {
            owned,
            record: {
                key,
                header,
                body,
                integrity: header.chat_metadata?.integrity ?? '',
                updatedAt: Math.floor(stat.mtimeMs),
                createdAt: Math.floor(stat.birthtimeMs || stat.ctimeMs),
            },
        };
    };
    const assertChatKey = key => {
        if (key.isGroup) {
            assertSafeRepoNameShape(key.groupId ?? key.name, { field: 'chat.groupId' });
        } else {
            assertSafeRepoNameShape(key.charDir, { field: 'chat.charDir' });
            assertSafeRepoNameShape(key.name, { field: 'chat.name' });
        }
    };
    const snapshots = new WeakMap();
    const sameOwned = (a, b) => b !== null && ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'mode'].every(field => a.stat[field] === b.stat[field]) && a.bytes.equals(b.bytes);
    const assertSourceUnchanged = snapshot => {
        const changed = namespace => { throw new ConflictError('rename_source_changed', { ...snapshot.key, namespace }); };
        if (!sameOwned(snapshot.owned, readOwned(snapshot.key, chatFilePath(snapshot.key)))) changed();
        const namespaces = listNamespaces(snapshot.key).sort();
        if (namespaces.length !== snapshot.states.length || namespaces.some((ns, index) => ns !== snapshot.states[index].namespace)) changed();
        for (const state of snapshot.states) {
            if (!sameOwned(state.owned, readOwned(snapshot.key, sidecarPath(snapshot.key, state.namespace)))) changed(state.namespace);
        }
    };

    tx._handlers.set('chat', {
        has(key) { return statEntry(key, chatFilePath(key)) !== null; },
        get(key) { return readParent(key)?.record ?? null; },
        captureMove(key) {
            const selected = readParent(key);
            if (selected === null) return null;
            const states = listNamespaces(key).sort().map(namespace => {
                const file = sidecarPath(key, namespace), owned = readOwned(key, file);
                if (owned === null) throw new Error(`Cannot read enumerated chat state at ${file}: entry is missing`);
                return { namespace, owned, value: parseChatJson(owned.raw, file) };
            });
            const token = Object.freeze({});
            snapshots.set(token, { key: { ...key }, ...selected, states });
            return token;
        },
        async publishMove(key, token) {
            const snapshot = snapshots.get(token);
            assertChatKey(key);
            assertSourceUnchanged(snapshot);
            const destinations = [chatFilePath(key), ...snapshot.states.map(state => sidecarPath(key, state.namespace))];
            try {
                await assertDistinctFsDestinations({
                    boundary: tx._directoriesByHandle(key.handle).root,
                    destinations: destinations.map(absolutePath => ({ absolutePath, treePath: path.basename(absolutePath), logicalIdentity: absolutePath, kind: 'file' })),
                    operation: 'rename chat',
                });
            } catch (error) {
                if (error.code === 'SYNC_FS_ALIAS') throw new ConflictError('rename_target_exists', key);
                throw error;
            }
            assertSourceUnchanged(snapshot);
            if (!createOnly(key, chatFilePath(key), snapshot.owned.bytes, snapshot.record.updatedAt, { requireEmptyState: true })) return { updated: false };
            for (const state of snapshot.states) {
                if (!createOnly(key, sidecarPath(key, state.namespace), state.owned.bytes, state.owned.stat.mtimeMs)) throw new ConflictError('rename_target_exists', { ...key, namespace: state.namespace });
            }
            return { updated: true };
        },
        deleteMoveSource(token) {
            const snapshot = snapshots.get(token);
            // Inspection and captured-path deletion share one synchronous local epoch.
            assertSourceUnchanged(snapshot);
            for (const state of snapshot.states) fs.unlinkSync(sidecarPath(snapshot.key, state.namespace));
            fs.unlinkSync(chatFilePath(snapshot.key));
            snapshots.delete(token);
        },
        put(key, record, { ifAbsent = false } = {}) {
            assertChatKey(key);
            const filePath = chatFilePath(key);
            confinedParent(key, filePath);
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            const headerWithIntegrity = chatHeaderWithIntegrity(record);
            const lines = [JSON.stringify(headerWithIntegrity)];
            for (const msg of record.body) lines.push(JSON.stringify(msg));
            if (ifAbsent) return createOnly(key, filePath, lines.join('\n') + '\n', record.updatedAt, { requireEmptyState: true });
            writeFileAtomic(filePath, lines.join('\n') + '\n');
            // Restore the caller-supplied updatedAt as the file mtime so a
            // migration-time saveRaw doesn't reset every chat's "last edited"
            // to the migration moment. createdAt maps to birthtime on FS,
            // which most OSes don't expose for writing — chat.get falls back
            // to ctime there, and a migrated chat will report the migration
            // moment as createdAt. The user payload is unaffected.
            if (typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt)) {
                const secs = record.updatedAt / 1000;
                try { fs.utimesSync(filePath, secs, secs); } catch { /* best-effort */ }
            }
        },
        delete(key) {
            const namespaces = listNamespaces(key);
            for (const ns of namespaces) {
                const sp = sidecarPath(key, ns);
                if (fs.existsSync(sp)) fs.unlinkSync(sp);
            }
            const filePath = chatFilePath(key);
            if (!fs.existsSync(filePath)) return false;
            fs.unlinkSync(filePath);
            return true;
        },
        list(filter) {
            const dirs = tx._directoriesByHandle(filter.handle);
            const out = [];

            // Walk per-character chats. Each subdirectory is one character's
            // chat folder; ".jsonl" files inside are individual chats. Honors
            // the optional filter.charDir filter; if absent, includes every
            // character.
            const walkCharacterChats = () => {
                if (!fs.existsSync(dirs.chats)) return;
                const charDirs = (typeof filter.charDir === 'string')
                    ? [filter.charDir]
                    : fs.readdirSync(dirs.chats);
                for (const charDir of charDirs) {
                    const charDirPath = path.join(dirs.chats, charDir);
                    let st;
                    try { st = fs.statSync(charDirPath); } catch { continue; }
                    if (!st.isDirectory()) continue;
                    for (const entry of fs.readdirSync(charDirPath)) {
                        if (!entry.endsWith('.jsonl')) continue;
                        const name = entry.slice(0, -'.jsonl'.length);
                        const filePath = path.join(charDirPath, entry);
                        const fileStat = fs.statSync(filePath);
                        out.push({
                            key: { kind: 'chat', handle: filter.handle, charDir, name, isGroup: false },
                            header: undefined,
                            body: undefined,
                            integrity: undefined,
                            updatedAt: Math.floor(fileStat.mtimeMs),
                            createdAt: Math.floor(fileStat.birthtimeMs || fileStat.ctimeMs),
                        });
                    }
                }
            };

            // Walk group chats. The chat row's `groupId` is the file's base
            // name minus ".jsonl"; the on-disk file lives flat under
            // <groupChats>/. There is no per-group subdirectory.
            const walkGroupChats = () => {
                if (!fs.existsSync(dirs.groupChats)) return;
                for (const entry of fs.readdirSync(dirs.groupChats)) {
                    if (!entry.endsWith('.jsonl')) continue;
                    const name = entry.slice(0, -'.jsonl'.length);
                    const filePath = path.join(dirs.groupChats, entry);
                    let fileStat;
                    try { fileStat = fs.statSync(filePath); } catch { continue; }
                    out.push({
                        key: {
                            kind: 'chat',
                            handle: filter.handle,
                            charDir: '',
                            name,
                            isGroup: true,
                            // For group chats the on-disk filename IS the chatId,
                            // and in the FS engine that chatId doubles as the
                            // groupId-routing key. Surface it so callers can
                            // resolve group identity without a second read.
                            groupId: name,
                        },
                        header: undefined,
                        body: undefined,
                        integrity: undefined,
                        updatedAt: Math.floor(fileStat.mtimeMs),
                        createdAt: Math.floor(fileStat.birthtimeMs || fileStat.ctimeMs),
                    });
                }
            };

            // Branch by filter:
            //   isGroup=false       → only character chats
            //   isGroup=true        → only group chats
            //   isGroup=undefined   → both, character first (insertion order
            //                         not load-bearing; downstream sorts by
            //                         orderBy)
            //   groupId given       → only group chats matching that id
            //   charDir given       → only that character (forced isGroup=false)
            if (typeof filter.groupId === 'string') {
                walkGroupChats();
                for (let i = out.length - 1; i >= 0; i--) {
                    if (out[i].key.groupId !== filter.groupId) out.splice(i, 1);
                }
            } else if (filter.isGroup === true) {
                walkGroupChats();
            } else if (filter.isGroup === false || typeof filter.charDir === 'string') {
                walkCharacterChats();
            } else {
                walkCharacterChats();
                walkGroupChats();
            }

            if (filter.orderBy === 'updatedAt') {
                out.sort((a, b) => b.updatedAt - a.updatedAt);
            } else if (filter.orderBy === 'name') {
                out.sort((a, b) => (a.key.name < b.key.name ? -1 : 1));
            }
            if (typeof filter.limit === 'number') out.length = Math.min(out.length, filter.limit);
            return out;
        },
        getSidecar(key, ns, { required = false } = {}) {
            const sp = sidecarPath(key, ns);
            const owned = readOwned(key, sp);
            if (owned === null) {
                if (required) throw new Error(`Cannot read enumerated chat state at ${sp}: entry is missing`);
                return null;
            }
            return parseChatJson(owned.raw, sp);
        },
        putSidecar(key, ns, doc, { ifAbsent = false } = {}) {
            const sp = sidecarPath(key, ns);
            if (ifAbsent) {
                if (!createOnly(key, sp, JSON.stringify(doc))) throw new ConflictError('rename_target_exists', { ...key, namespace: ns });
                return;
            }
            fs.mkdirSync(path.dirname(sp), { recursive: true });
            writeFileAtomic(sp, JSON.stringify(doc));
        },
        deleteSidecar(key, ns) {
            const sp = sidecarPath(key, ns);
            if (!fs.existsSync(sp)) return false;
            fs.unlinkSync(sp);
            return true;
        },
        listSidecarNamespaces(key) {
            return listNamespaces(key);
        },
    });
}

function registerSettingsHandler(tx) {
    const filePath = (key) => path.join(tx._directoriesByHandle(key.handle).root, 'settings.json');
    tx._handlers.set('settings', {
        get(key) {
            const fp = filePath(key);
            if (!fs.existsSync(fp)) return null;
            return JSON.parse(fs.readFileSync(fp, 'utf-8'));
        },
        getResourceField(key, segments) {
            const fp = filePath(key);
            const doc = readCurrentJsonFile(fp);
            if (doc == null) {
                return { exists: false };
            }
            let current = doc;
            let parentType;
            for (const segment of segments) {
                if (current === null || typeof current !== 'object' || Array.isArray(current)
                    || !Object.prototype.hasOwnProperty.call(current, segment)) {
                    return { exists: false };
                }
                parentType = jsonTypeOf(current);
                current = current[segment];
            }
            return { exists: true, value: current, type: jsonTypeOf(current), parentType };
        },
        getResourceFieldType(key, segments) {
            const fp = filePath(key);
            const doc = readCurrentJsonFile(fp);
            if (doc == null) {
                return { exists: false };
            }
            let current = doc;
            for (const segment of segments) {
                if (current === null || typeof current !== 'object' || Array.isArray(current)
                    || !Object.prototype.hasOwnProperty.call(current, segment)) {
                    return { exists: false };
                }
                current = current[segment];
            }
            return { exists: true, type: jsonTypeOf(current) };
        },
        put(key, record) {
            const fp = filePath(key);
            fs.mkdirSync(path.dirname(fp), { recursive: true });
            writeFileAtomic(fp, JSON.stringify(record.doc, null, 4));
            invalidateCurrentJsonFile(fp);
        },
        delete(key) {
            const fp = filePath(key);
            if (!fs.existsSync(fp)) return false;
            fs.unlinkSync(fp);
            invalidateCurrentJsonFile(fp);
            return true;
        },
        list() { throw new Error('settings is a singleton; list unsupported'); },
    });
    tx.getResourceField = (key, segments) => tx._h('settings', 'getResourceField').getResourceField(key, segments);
    tx.getResourceFieldType = (key, segments) => tx._h('settings', 'getResourceFieldType').getResourceFieldType(key, segments);
}

function registerPresetHandler(tx) {
    const document = key => ({ kind: 'preset', dirKey: key.dirKey, name: key.name });
    const state = (key, namespace) => ({ kind: 'preset-state', dirKey: key.dirKey, name: key.name, namespace });
    const inventory = key => {
        const dirs = tx._directoriesByHandle(key.handle);
        return readPresetInventory({ folder: dirs[key.dirKey], dirKey: key.dirKey, boundary: dirs.root });
    };
    const get = (key, record) => {
        const entry = selectPresetEntry(inventory(key), record);
        return entry ? readPresetEntry(entry).doc : null;
    };
    const put = async (key, record, doc) => {
        const dirs = tx._directoriesByHandle(key.handle);
        const current = inventory(key);
        const owned = current.entries.get(presetRecordIdentity(record));
        const absolutePath = owned?.absolutePath ?? path.join(dirs[key.dirKey], ...encodePresetRecordRelativePath(record).split('/'));
        const destinations = [...current.entries.values()].map(entry => ({ treePath: entry.relativePath, absolutePath: entry.absolutePath, logicalIdentity: presetRecordIdentity(entry.record), kind: 'file' }));
        destinations.push({ treePath: encodePresetRecordRelativePath(record), absolutePath, logicalIdentity: presetRecordIdentity(record), kind: 'file' });
        await assertDistinctFsDestinations({ boundary: dirs.root, destinations, operation: 'save preset record' });
        assertConfinedPath({ boundary: dirs.root, absolutePath });
        fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
        writeFileAtomic(absolutePath, JSON.stringify(doc, null, 4));
    };
    const remove = entry => {
        assertConfinedPath({ boundary: entry.boundary, absolutePath: entry.absolutePath });
        fs.unlinkSync(entry.absolutePath);
    };
    const namespaces = key => [...inventory(key).entries.values()].filter(entry => entry.record.kind === 'preset-state' && entry.record.name === key.name).map(entry => entry.record.namespace).sort();
    tx._handlers.set('preset', {
        get: key => get(key, document(key)),
        put(key, value) {
            assertSafeRepoNameShape(key.name, { field: 'preset.name' });
            return put(key, document(key), value.doc);
        },
        delete(key) {
            const current = inventory(key);
            const entry = selectPresetEntry(current, document(key));
            if (!entry) return false;
            for (const stateEntry of current.entries.values()) if (stateEntry.record.kind === 'preset-state' && stateEntry.record.name === key.name) remove(stateEntry);
            remove(entry);
            return true;
        },
        list(filter) {
            const dirKey = PRESET_FOLDER_BY_API_ID[filter.apiId];
            if (!dirKey) throw new Error(`preset list: invalid apiId ${filter.apiId}`);
            return [...inventory({ ...filter, dirKey }).entries.values()].filter(entry => entry.record.kind === 'preset').map(entry => ({ key: { ...entry.record, handle: filter.handle } }));
        },
        getPresetSidecar: (key, namespace) => get(key, state(key, namespace)),
        putPresetSidecar: (key, namespace, doc) => put(key, state(key, namespace), doc),
        deletePresetSidecar(key, namespace) {
            const entry = selectPresetEntry(inventory(key), state(key, namespace));
            if (!entry) return false;
            remove(entry);
            return true;
        },
        listPresetSidecarNamespaces: namespaces,
        listPresetStateRecords(filter) {
            return [...inventory(filter).entries.values()].filter(entry => entry.record.kind === 'preset-state').map(({ record }) => ({ name: record.name, namespace: record.namespace }));
        },
    });
}

function registerWorldInfoHandler(tx) {
    const worldsDir = (handle) => tx._directoriesByHandle(handle).worlds;

    const sanitizeName = (name) => {
        const requested = String(name || '').trim();
        return requested ? sanitizeFilename(requested) : '';
    };

    const resolveCanonicalFilename = (key) => {
        const requested = String(key.name || '').trim();
        const safe = sanitizeName(requested);
        const exactName = safe ? `${safe}.json` : '';
        const dir = worldsDir(key.handle);
        if (exactName) {
            const exactPath = path.join(dir, exactName);
            if (fs.existsSync(exactPath)) return exactName;
        }
        if (!fs.existsSync(dir)) return null;
        const jsonFiles = fs.readdirSync(dir)
            .filter((f) => path.extname(f).toLowerCase() === '.json');
        if (requested) {
            const exactMatch = jsonFiles.find((f) => path.parse(f).name === requested);
            if (exactMatch) return exactMatch;
            const normalizedRequested = normalizeLookupText(requested);
            if (normalizedRequested) {
                const tolerant = jsonFiles.find((f) => normalizeLookupText(path.parse(f).name) === normalizedRequested);
                if (tolerant) return tolerant;
            }
        }
        return null;
    };

    const exactFilePath = (key) => {
        const safe = sanitizeName(key.name);
        if (!safe) return null;
        return path.join(worldsDir(key.handle), `${safe}.json`);
    };

    tx._handlers.set('world', {
        get(key) {
            const filename = resolveCanonicalFilename(key);
            if (!filename) return null;
            const fp = path.join(worldsDir(key.handle), filename);
            if (!fs.existsSync(fp)) return null;
            const raw = fs.readFileSync(fp, 'utf-8');
            if (!raw) return null;
            try {
                const parsed = JSON.parse(raw);
                if (!_.isObjectLike(parsed) || Array.isArray(parsed)) return null;
                return parsed;
            } catch { return null; }
        },
        put(key, record) {
            assertSafeRepoNameShape(key.name, { field: 'world.name' });
            const existing = resolveCanonicalFilename(key);
            const fp = existing
                ? path.join(worldsDir(key.handle), existing)
                : exactFilePath(key);
            if (!fp) throw new Error(`world put: invalid name ${key.name}`);
            fs.mkdirSync(path.dirname(fp), { recursive: true });
            writeFileAtomic(fp, JSON.stringify(record.doc, null, 4));
        },
        delete(key) {
            const filename = resolveCanonicalFilename(key);
            if (!filename) return false;
            const fp = path.join(worldsDir(key.handle), filename);
            if (!fs.existsSync(fp)) return false;
            fs.unlinkSync(fp);
            return true;
        },
        list(filter) {
            const dir = worldsDir(filter.handle);
            if (!fs.existsSync(dir)) return [];
            const entries = fs.readdirSync(dir, { withFileTypes: true })
                .filter((e) => e.isFile() && path.extname(e.name).toLowerCase() === '.json')
                .sort((a, b) => a.name.localeCompare(b.name));
            const out = [];
            for (const entry of entries) {
                const fp = path.join(dir, entry.name);
                let parsed = null;
                try {
                    const raw = fs.readFileSync(fp, 'utf-8');
                    parsed = JSON.parse(raw);
                } catch {
                    parsed = null;
                }
                const fileNameWithoutExt = path.parse(entry.name).name;
                const safeParsed = (_.isObjectLike(parsed) && !Array.isArray(parsed)) ? parsed : {};
                const extensions = _.isObjectLike(safeParsed.extensions) && !Array.isArray(safeParsed.extensions)
                    ? safeParsed.extensions
                    : {};
                out.push({
                    key: { kind: 'world', handle: filter.handle, name: fileNameWithoutExt },
                    name: safeParsed.name || fileNameWithoutExt,
                    extensions,
                });
            }
            return out;
        },
    });

    tx.listWorldNames = async (handle) => {
        const dir = worldsDir(handle);
        if (!fs.existsSync(dir)) return [];
        return fs.readdirSync(dir)
            .filter((entry) => path.extname(entry).toLowerCase() === '.json')
            .map((entry) => path.parse(entry).name)
            .sort((a, b) => a.localeCompare(b));
    };

    tx.resolveWorldName = async (key) => {
        const filename = resolveCanonicalFilename(key);
        return filename ? path.parse(filename).name : null;
    };
}

function registerNamedDocHandler(tx) {
    const folderPath = (key) => tx._directoriesByHandle(key.handle)[BUCKET_TO_DIR[key.bucket]];
    const filePath = (key) => {
        // Existing keys come from filenames; rewriting them can select a sibling.
        const name = String(key.name || '');
        if (!name || /[/\\\0]/.test(name)) throw new Error(`named-doc: invalid name ${key.name}`);
        const fp = path.join(folderPath(key), `${name}.json`);
        assertConfinedPath({ boundary: tx._directoriesByHandle(key.handle).root, absolutePath: fp });
        return fp;
    };

    tx._handlers.set('named-doc', {
        get(key) {
            const fp = filePath(key);
            if (!fs.existsSync(fp)) return null;
            const raw = fs.readFileSync(fp, 'utf-8');
            if (!raw) return null;
            try {
                const parsed = JSON.parse(raw);
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
                return parsed;
            } catch { return null; }
        },
        put(key, record) {
            const name = assertSafeRepoNameShape(key.name, { field: 'named-doc.name' });
            const fp = filePath({ ...key, name });
            fs.mkdirSync(path.dirname(fp), { recursive: true });
            writeFileAtomic(fp, JSON.stringify(record.doc, null, 4));
        },
        delete(key) {
            const fp = filePath(key);
            if (!fs.existsSync(fp)) return false;
            fs.unlinkSync(fp);
            return true;
        },
        list(filter) {
            const dirKey = BUCKET_TO_DIR[filter.bucket];
            if (!dirKey) throw new Error(`named-doc list: invalid bucket ${filter.bucket}`);
            const dir = tx._directoriesByHandle(filter.handle)[dirKey];
            if (!fs.existsSync(dir)) return [];
            const out = [];
            for (const entry of fs.readdirSync(dir)) {
                if (!entry.endsWith('.json')) continue;
                out.push({
                    key: {
                        kind: 'named-doc',
                        handle: filter.handle,
                        bucket: filter.bucket,
                        name: entry.slice(0, -'.json'.length),
                    },
                });
            }
            return out.sort((a, b) => (a.key.name < b.key.name ? -1 : 1));
        },
    });
}

function registerGroupHandler(tx) {
    const folderPath = (handle) => tx._directoriesByHandle(handle).groups;
    const filePath = (key) => {
        const sanitized = sanitizeFilename(String(key.id || '').trim());
        if (!sanitized) throw new Error(`group: invalid id ${key.id}`);
        return path.join(folderPath(key.handle), `${sanitized}.json`);
    };

    tx._handlers.set('group', {
        get(key) {
            const fp = filePath(key);
            if (!fs.existsSync(fp)) return null;
            const raw = fs.readFileSync(fp, 'utf-8');
            if (!raw) return null;
            try {
                const parsed = JSON.parse(raw);
                if (!_.isObjectLike(parsed) || Array.isArray(parsed)) return null;
                return parsed;
            } catch { return null; }
        },
        put(key, record) {
            assertSafeRepoNameShape(key.id, { field: 'group.id' });
            const fp = filePath(key);
            fs.mkdirSync(path.dirname(fp), { recursive: true });
            writeFileAtomic(fp, JSON.stringify(record.doc, null, 4));
        },
        delete(key) {
            const fp = filePath(key);
            if (!fs.existsSync(fp)) return false;
            fs.unlinkSync(fp);
            return true;
        },
        list(filter) {
            const dir = folderPath(filter.handle);
            if (!fs.existsSync(dir)) return [];
            const out = [];
            for (const entry of fs.readdirSync(dir)) {
                if (!entry.endsWith('.json')) continue;
                const id = entry.slice(0, -'.json'.length);
                out.push({ key: { kind: 'group', handle: filter.handle, id } });
            }
            return out.sort((a, b) => (a.key.id < b.key.id ? -1 : 1));
        },
    });

    // Composite read for /all — replicates legacy getGroupsSnapshot semantics:
    // joins group metadata with member-chat file stats (chat_size, date_last_chat).
    tx.listGroupsWithChatStats = async (filter) => {
        const dirs = tx._directoriesByHandle(filter.handle);
        if (!fs.existsSync(dirs.groups)) {
            fs.mkdirSync(dirs.groups, { recursive: true });
        }
        const groupFiles = fs.readdirSync(dirs.groups).filter((x) => path.extname(x) === '.json');
        const chatFiles = fs.existsSync(dirs.groupChats)
            ? fs.readdirSync(dirs.groupChats).filter((x) => path.extname(x) === '.jsonl')
            : [];
        const groups = [];
        for (const file of groupFiles) {
            try {
                const fp = path.join(dirs.groups, file);
                const raw = fs.readFileSync(fp, 'utf-8');
                const group = JSON.parse(raw);
                const groupStat = fs.statSync(fp);
                // Prefer doc.date_added (set by GroupRepo.save on first write)
                // so the value survives FS↔DB migration. Fall back to the file
                // birthtime for groups created before the GroupRepo started
                // stamping date_added.
                const docDateAdded = (typeof group.date_added === 'number' && Number.isFinite(group.date_added))
                    ? group.date_added
                    : null;
                group.date_added = docDateAdded ?? groupStat.birthtimeMs;
                group.create_date = new Date(group.date_added).toISOString();
                let chat_size = 0;
                let date_last_chat = 0;
                if (Array.isArray(group.chats)) {
                    for (const chat of chatFiles) {
                        if (group.chats.includes(path.parse(chat).name)) {
                            const chatStat = fs.statSync(path.join(dirs.groupChats, chat));
                            chat_size += chatStat.size;
                            date_last_chat = Math.max(date_last_chat, chatStat.mtimeMs);
                        }
                    }
                }
                group.date_last_chat = date_last_chat;
                group.chat_size = chat_size;
                groups.push(group);
            } catch (error) {
                console.error(error);
            }
        }
        return groups;
    };
}

function registerStatsHandler(tx) {
    const filePath = (key) => path.join(tx._directoriesByHandle(key.handle).root, 'stats.json');
    tx._handlers.set('stats', {
        get(key) {
            const fp = filePath(key);
            if (!fs.existsSync(fp)) return null;
            const raw = fs.readFileSync(fp, 'utf-8');
            if (!raw) return null;
            try { return JSON.parse(raw); } catch { return null; }
        },
        put(key, record) {
            const fp = filePath(key);
            fs.mkdirSync(path.dirname(fp), { recursive: true });
            writeFileAtomic(fp, JSON.stringify(record.doc));
        },
        delete(key) {
            const fp = filePath(key);
            if (!fs.existsSync(fp)) return false;
            fs.unlinkSync(fp);
            return true;
        },
        list() { throw new Error('FsTransaction.list: stats is a singleton'); },
    });
}
