import fs from 'node:fs';
import path from 'node:path';

import _ from 'lodash';
import sanitizeFilename from 'sanitize-filename';
import { sync as writeFileAtomic } from 'write-file-atomic';

import { SIDECAR_INFIX, buildSidecarFilename, parseSidecarFilename } from './sidecar-naming.js';
import { PRESET_FOLDER_BY_API_ID } from '../repositories/preset-repo.js';
import { BUCKET_TO_DIR } from '../repositories/named-doc-repo.js';
import { normalizeLookupText } from '../../util.js';

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

    async getChatState(chatKey, namespace) {
        return this._h(chatKey.kind, 'getChatState').getSidecar(chatKey, namespace);
    }

    async putChatState(chatKey, namespace, doc) {
        return this._h(chatKey.kind, 'putChatState').putSidecar(chatKey, namespace, doc);
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

    const listNamespaces = (key) => {
        const dir = path.dirname(chatFilePath(key));
        if (!fs.existsSync(dir)) return [];
        const base = path.basename(chatFilePath(key), '.jsonl');
        const out = [];
        for (const entry of fs.readdirSync(dir)) {
            const ns = parseSidecarFilename(entry, base);
            if (ns !== null) out.push(ns);
        }
        return out;
    };

    tx._handlers.set('chat', {
        get(key) {
            const filePath = chatFilePath(key);
            if (!fs.existsSync(filePath)) return null;
            const raw = fs.readFileSync(filePath, 'utf-8');
            const lines = raw.split('\n').filter((l) => l.length > 0);
            if (lines.length === 0) return null;
            const header = JSON.parse(lines[0]);
            const integrity = header.chat_metadata?.integrity ?? '';
            const body = lines.slice(1).map((l) => JSON.parse(l));
            const stat = fs.statSync(filePath);
            return {
                key,
                header,
                body,
                integrity,
                updatedAt: Math.floor(stat.mtimeMs),
                createdAt: Math.floor(stat.birthtimeMs || stat.ctimeMs),
            };
        },
        put(key, record) {
            const filePath = chatFilePath(key);
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            const headerWithIntegrity = {
                ...record.header,
                chat_metadata: {
                    ...(record.header.chat_metadata ?? {}),
                    integrity: record.integrity,
                },
            };
            const lines = [JSON.stringify(headerWithIntegrity)];
            for (const msg of record.body) lines.push(JSON.stringify(msg));
            writeFileAtomic(filePath, lines.join('\n') + '\n');
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
        getSidecar(key, ns) {
            const sp = sidecarPath(key, ns);
            if (!fs.existsSync(sp)) return null;
            const raw = fs.readFileSync(sp, 'utf-8');
            try { return JSON.parse(raw); } catch { return null; }
        },
        putSidecar(key, ns, doc) {
            const sp = sidecarPath(key, ns);
            fs.mkdirSync(path.dirname(sp), { recursive: true });
            writeFileAtomic(sp, JSON.stringify(doc));
        },
        deleteSidecar(key, ns) {
            const sp = sidecarPath(key, ns);
            if (fs.existsSync(sp)) fs.unlinkSync(sp);
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
        put(key, record) {
            const fp = filePath(key);
            fs.mkdirSync(path.dirname(fp), { recursive: true });
            writeFileAtomic(fp, JSON.stringify(record.doc, null, 4));
        },
        delete(key) {
            const fp = filePath(key);
            if (fs.existsSync(fp)) fs.unlinkSync(fp);
        },
        list() { throw new Error('settings is a singleton; list unsupported'); },
    });
}

function registerPresetHandler(tx) {
    const folderPath = (key) => tx._directoriesByHandle(key.handle)[key.dirKey];
    const filePath = (key) => path.join(folderPath(key), `${key.name}.json`);
    const sidecarPath = (key, ns) =>
        path.join(folderPath(key), buildSidecarFilename(key.name, ns));

    const listNs = (key) => {
        const dir = folderPath(key);
        if (!fs.existsSync(dir)) return [];
        const out = [];
        for (const entry of fs.readdirSync(dir)) {
            const ns = parseSidecarFilename(entry, key.name);
            if (ns !== null) out.push(ns);
        }
        return out;
    };

    tx._handlers.set('preset', {
        get(key) {
            const fp = filePath(key);
            if (!fp || !fs.existsSync(fp)) return null;
            const raw = fs.readFileSync(fp, 'utf-8');
            if (!raw) return null;
            try {
                const parsed = JSON.parse(raw);
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
                return null;
            } catch { return null; }
        },
        put(key, record) {
            const fp = filePath(key);
            fs.mkdirSync(path.dirname(fp), { recursive: true });
            writeFileAtomic(fp, JSON.stringify(record.doc, null, 4));
        },
        delete(key) {
            const fp = filePath(key);
            if (!fs.existsSync(fp)) return false;
            for (const ns of listNs(key)) {
                const sp = sidecarPath(key, ns);
                if (fs.existsSync(sp)) fs.unlinkSync(sp);
            }
            fs.unlinkSync(fp);
            return true;
        },
        list(filter) {
            const dirKey = PRESET_FOLDER_BY_API_ID[filter.apiId];
            if (!dirKey) throw new Error(`preset list: invalid apiId ${filter.apiId}`);
            const dir = tx._directoriesByHandle(filter.handle)[dirKey];
            if (!fs.existsSync(dir)) return [];
            const out = [];
            for (const entry of fs.readdirSync(dir)) {
                if (!entry.endsWith('.json')) continue;
                if (entry.includes(SIDECAR_INFIX)) continue;
                const name = entry.slice(0, -'.json'.length);
                out.push({ key: { kind: 'preset', handle: filter.handle, dirKey, name } });
            }
            return out;
        },
        getPresetSidecar(key, ns) {
            const sp = sidecarPath(key, ns);
            if (!fs.existsSync(sp)) return null;
            const raw = fs.readFileSync(sp, 'utf-8');
            if (!raw) return null;
            try {
                const parsed = JSON.parse(raw);
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
                return null;
            } catch { return null; }
        },
        putPresetSidecar(key, ns, doc) {
            const sp = sidecarPath(key, ns);
            fs.mkdirSync(path.dirname(sp), { recursive: true });
            writeFileAtomic(sp, JSON.stringify(doc, null, 4));
        },
        deletePresetSidecar(key, ns) {
            const sp = sidecarPath(key, ns);
            if (!fs.existsSync(sp)) return false;
            fs.unlinkSync(sp);
            return true;
        },
        listPresetSidecarNamespaces(key) {
            return listNs(key);
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

    tx.resolveWorldName = async (key) => {
        const filename = resolveCanonicalFilename(key);
        return filename ? path.parse(filename).name : null;
    };
}

function registerNamedDocHandler(tx) {
    const folderPath = (key) => tx._directoriesByHandle(key.handle)[BUCKET_TO_DIR[key.bucket]];
    const filePath = (key) => {
        const sanitized = sanitizeFilename(String(key.name || '').trim());
        if (!sanitized) throw new Error(`named-doc: invalid name ${key.name}`);
        return path.join(folderPath(key), `${sanitized}.json`);
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
                group.date_added = groupStat.birthtimeMs;
                group.create_date = new Date(groupStat.birthtimeMs).toISOString();
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
