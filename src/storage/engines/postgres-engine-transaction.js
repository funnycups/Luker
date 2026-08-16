import { NotFoundError } from '../errors.js';
import { assertSafeRepoNameShape } from '../name-validation.js';
import { normalizeLookupText } from '../../util.js';

// PgTransaction — pg-driver port of MysqlTransaction / SqliteTransaction.
// Same handler surface and per-kind methods so Repos remain engine-agnostic.
// Differences from the MySQL version:
//   - `client.query(sql, params)` returns `{rows, rowCount, ...}` — no array
//     destructuring; access `.rows` directly and use `.rowCount` for affected-
//     row checks (mysql2 uses `affectedRows` on the result object).
//   - Placeholders are `$1, $2, ...` instead of `?`. Written directly into the
//     SQL strings, no rewriting needed.
//   - Upsert syntax: `INSERT ... ON CONFLICT (cols) DO UPDATE SET col = EXCLUDED.col`
//     instead of MySQL's aliased-row form (`AS new ... DO UPDATE SET col =
//     new.col`). Semantics identical.
//   - JSONB columns return parsed JS objects from the driver by default;
//     `coerceJson` defensively handles the rare case where a driver upgrade
//     starts returning strings, mirroring the MysqlTransaction helper.
//   - For BIGINT timestamps, postgres-engine.js installs a process-global type
//     parser converting OID 20 → Number, so updated_at/created_at arrive as JS
//     numbers (same shape as mysql2 / better-sqlite3).
//   - chats.integrity is a STORED GENERATED column using `doc #>>
//     '{header,chat_metadata,integrity}'` (returns text directly, no
//     UNQUOTE wrapper needed unlike MySQL's JSON_UNQUOTE(JSON_EXTRACT(...))).
//   - For listGroupsWithChatStats's chat_size, MySQL uses LENGTH(CAST(doc AS
//     CHAR)); Postgres uses LENGTH(doc::text). Same approximate semantics —
//     the documented MysqlTransaction caveat (JSON gets re-serialized with
//     whitespace, so the integer differs from the original JSON.stringify
//     length) applies equally here.
export class PgTransaction {
    constructor({ client, handle }) {
        this._client = client;
        this._handle = handle;
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
        if (!h) throw new Error(`PgTransaction.${method}: unsupported kind ${kind}`);
        return h;
    }

    async getResource(key)       { return this._h(key.kind, 'getResource').get(key); }
    async putResource(key, rec)  { return this._h(key.kind, 'putResource').put(key, rec); }
    async deleteResource(key)    { return this._h(key.kind, 'deleteResource').delete(key); }
    async listResources(filter)  { return this._h(filter.kind, 'listResources').list(filter); }

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
}

// pg auto-parses JSONB columns to JS objects, but be defensive: a future
// connection-flag change or driver upgrade could revert to raw strings. This
// helper covers both shapes uniformly so each handler keeps a single read
// path. Returns the parsed object or null on parse failure / non-object.
function coerceJson(value) {
    if (value == null) return null;
    if (typeof value === 'object') return value;
    if (typeof value !== 'string') return null;
    try {
        const parsed = JSON.parse(value);
        return parsed;
    } catch { return null; }
}

// Same parity note as MysqlTransaction / SqliteTransaction: group chats may
// be addressed by `groupId` alone or `name` alone; stored rows always have
// both populated, so back-fill each from the other before binding to SQL or
// a later lookup that drops one side won't match.
function chatKeyToParams(key) {
    const isGroup = !!key.isGroup;
    const groupIdRaw = key.groupId != null ? String(key.groupId) : '';
    const nameRaw = key.name != null ? String(key.name) : '';
    const groupId = isGroup ? (groupIdRaw || nameRaw) : groupIdRaw;
    const name = isGroup ? (nameRaw || groupIdRaw) : nameRaw;
    return {
        handle: key.handle,
        char_dir: key.charDir ?? '',
        name,
        is_group: isGroup ? 1 : 0,
        group_id: groupId,
    };
}

export function registerChatHandler(tx) {
    const client = tx._client;

    async function readRow(p) {
        const r = await client.query(
            `SELECT doc, integrity, updated_at, created_at
             FROM chats WHERE handle=$1 AND char_dir=$2 AND name=$3 AND is_group=$4 AND group_id=$5`,
            [p.handle, p.char_dir, p.name, p.is_group, p.group_id],
        );
        return r.rows[0] || null;
    }

    tx._handlers.set('chat', {
        async get(key) {
            const p = chatKeyToParams(key);
            const row = await readRow(p);
            if (!row) return null;
            const parsed = coerceJson(row.doc);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
            if (!parsed.header || typeof parsed.header !== 'object' || Array.isArray(parsed.header)) return null;
            if (!Array.isArray(parsed.body)) return null;
            return {
                key,
                header: parsed.header,
                body: parsed.body,
                integrity: row.integrity ?? '',
                updatedAt: row.updated_at,
                createdAt: row.created_at,
            };
        },
        async put(key, record) {
            if (key.isGroup) {
                assertSafeRepoNameShape(key.groupId ?? key.name, { field: 'chat.groupId' });
            } else {
                assertSafeRepoNameShape(key.charDir, { field: 'chat.charDir' });
                assertSafeRepoNameShape(key.name, { field: 'chat.name' });
            }
            const p = chatKeyToParams(key);
            const headerWithIntegrity = {
                ...record.header,
                chat_metadata: {
                    ...(record.header.chat_metadata ?? {}),
                    integrity: record.integrity,
                },
            };
            const doc = JSON.stringify({ header: headerWithIntegrity, body: record.body });
            // Preserve existing created_at on upsert; only set fresh on first insert.
            const existing = await readRow(p);
            const now = Date.now();
            const updatedAt = record.updatedAt ?? now;
            const createdAt = record.createdAt ?? existing?.created_at ?? now;
            await client.query(
                `INSERT INTO chats (handle, char_dir, name, is_group, group_id, doc, updated_at, created_at)
                 VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
                 ON CONFLICT (handle, char_dir, name, is_group, group_id)
                 DO UPDATE SET doc = EXCLUDED.doc, updated_at = EXCLUDED.updated_at`,
                [p.handle, p.char_dir, p.name, p.is_group, p.group_id, doc, updatedAt, createdAt],
            );
        },
        async delete(key) {
            // FK CASCADE drops chat_states rows automatically when parent row goes.
            const p = chatKeyToParams(key);
            const r = await client.query(
                'DELETE FROM chats WHERE handle=$1 AND char_dir=$2 AND name=$3 AND is_group=$4 AND group_id=$5',
                [p.handle, p.char_dir, p.name, p.is_group, p.group_id],
            );
            return r.rowCount > 0;
        },
        async list(filter) {
            const where = ['handle = $1'];
            const args = [filter.handle];
            if (typeof filter.charDir === 'string') {
                args.push(filter.charDir);
                where.push(`char_dir = $${args.length}`);
            }
            if (typeof filter.isGroup === 'boolean') {
                args.push(filter.isGroup ? 1 : 0);
                where.push(`is_group = $${args.length}`);
            }
            if (typeof filter.groupId === 'string') {
                args.push(filter.groupId);
                where.push(`group_id = $${args.length}`);
            }
            const orderClause = filter.orderBy === 'name' ? 'ORDER BY name ASC' : 'ORDER BY updated_at DESC';
            const r = await client.query(
                `SELECT char_dir, name, is_group, group_id, updated_at, created_at
                 FROM chats WHERE ${where.join(' AND ')} ${orderClause}`,
                args,
            );
            const out = r.rows.map((row) => ({
                key: {
                    kind: 'chat',
                    handle: filter.handle,
                    charDir: row.char_dir,
                    name: row.name,
                    isGroup: !!row.is_group,
                    groupId: row.group_id || undefined,
                },
                header: undefined,
                body: undefined,
                integrity: undefined,
                updatedAt: row.updated_at,
                createdAt: row.created_at,
            }));
            if (typeof filter.limit === 'number') return out.slice(0, filter.limit);
            return out;
        },
    });

    // Sidecar tx methods — direct on tx, matching MysqlTransaction surface.
    tx.getChatState = async (chatKey, namespace) => {
        const p = chatKeyToParams(chatKey);
        const r = await client.query(
            `SELECT doc FROM chat_states
             WHERE handle=$1 AND char_dir=$2 AND name=$3 AND is_group=$4 AND group_id=$5 AND namespace=$6`,
            [p.handle, p.char_dir, p.name, p.is_group, p.group_id, namespace],
        );
        const row = r.rows[0];
        if (!row) return null;
        return coerceJson(row.doc);
    };

    tx.putChatState = async (chatKey, namespace, doc) => {
        const p = chatKeyToParams(chatKey);
        // Precheck parent exists so we raise a typed NotFoundError instead of
        // bubbling Postgres's raw FK error (foreign_key_violation, SQLSTATE
        // 23503). Same STRICT behavior as MysqlTransaction.
        const parentRows = await client.query(
            'SELECT 1 FROM chats WHERE handle=$1 AND char_dir=$2 AND name=$3 AND is_group=$4 AND group_id=$5',
            [p.handle, p.char_dir, p.name, p.is_group, p.group_id],
        );
        if (!parentRows.rows.length) {
            throw new NotFoundError('chat', {
                handle: chatKey.handle,
                charDir: chatKey.charDir,
                name: chatKey.name,
            });
        }
        await client.query(
            `INSERT INTO chat_states (handle, char_dir, name, is_group, group_id, namespace, doc)
             VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
             ON CONFLICT (handle, char_dir, name, is_group, group_id, namespace)
             DO UPDATE SET doc = EXCLUDED.doc`,
            [p.handle, p.char_dir, p.name, p.is_group, p.group_id, namespace, JSON.stringify(doc)],
        );
    };

    tx.deleteChatState = async (chatKey, namespace) => {
        const p = chatKeyToParams(chatKey);
        const r = await client.query(
            `DELETE FROM chat_states
             WHERE handle=$1 AND char_dir=$2 AND name=$3 AND is_group=$4 AND group_id=$5 AND namespace=$6`,
            [p.handle, p.char_dir, p.name, p.is_group, p.group_id, namespace],
        );
        return r.rowCount > 0;
    };

    tx.listChatStateNamespaces = async (chatKey) => {
        const p = chatKeyToParams(chatKey);
        const r = await client.query(
            `SELECT namespace FROM chat_states
             WHERE handle=$1 AND char_dir=$2 AND name=$3 AND is_group=$4 AND group_id=$5`,
            [p.handle, p.char_dir, p.name, p.is_group, p.group_id],
        );
        return r.rows.map((row) => row.namespace);
    };
}

export function registerSettingsHandler(tx) {
    const client = tx._client;
    tx._handlers.set('settings', {
        async get(key) {
            const r = await client.query('SELECT doc FROM settings WHERE handle=$1', [key.handle]);
            if (!r.rows.length) return null;
            return coerceJson(r.rows[0].doc);
        },
        async put(key, record) {
            await client.query(
                `INSERT INTO settings (handle, doc, updated_at) VALUES ($1, $2::jsonb, $3)
                 ON CONFLICT (handle) DO UPDATE SET doc = EXCLUDED.doc, updated_at = EXCLUDED.updated_at`,
                [key.handle, JSON.stringify(record.doc), Date.now()],
            );
        },
        async delete(key) {
            const r = await client.query('DELETE FROM settings WHERE handle=$1', [key.handle]);
            return r.rowCount > 0;
        },
        list() { throw new Error('PgTransaction.list: settings is a singleton'); },
    });
}

function presetKeyToParams(key) {
    return { handle: key.handle, dir_key: key.dirKey, name: key.name };
}

export function registerPresetHandler(tx) {
    const client = tx._client;
    tx._handlers.set('preset', {
        async get(key) {
            const p = presetKeyToParams(key);
            const r = await client.query(
                'SELECT doc FROM presets WHERE handle=$1 AND dir_key=$2 AND name=$3',
                [p.handle, p.dir_key, p.name],
            );
            if (!r.rows.length) return null;
            const parsed = coerceJson(r.rows[0].doc);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
            return null;
        },
        async put(key, record) {
            assertSafeRepoNameShape(key.name, { field: 'preset.name' });
            const p = presetKeyToParams(key);
            await client.query(
                `INSERT INTO presets (handle, dir_key, name, doc, updated_at) VALUES ($1, $2, $3, $4::jsonb, $5)
                 ON CONFLICT (handle, dir_key, name) DO UPDATE SET doc = EXCLUDED.doc, updated_at = EXCLUDED.updated_at`,
                [p.handle, p.dir_key, p.name, JSON.stringify(record.doc), Date.now()],
            );
        },
        async delete(key) {
            const p = presetKeyToParams(key);
            // Cascade sidecars manually (no FK on preset_states; mirrors SQLite/MySQL).
            await client.query(
                'DELETE FROM preset_states WHERE handle=$1 AND dir_key=$2 AND name=$3',
                [p.handle, p.dir_key, p.name],
            );
            const r = await client.query(
                'DELETE FROM presets WHERE handle=$1 AND dir_key=$2 AND name=$3',
                [p.handle, p.dir_key, p.name],
            );
            return r.rowCount > 0;
        },
        async list(filter) {
            const r = await client.query(
                'SELECT name FROM presets WHERE handle=$1 AND dir_key=$2 ORDER BY name ASC',
                [filter.handle, filter.dirKey],
            );
            return r.rows.map((row) => ({
                key: { kind: 'preset', handle: filter.handle, dirKey: filter.dirKey, name: row.name },
            }));
        },
    });

    tx.getPresetState = async (key, namespace) => {
        const p = presetKeyToParams(key);
        const r = await client.query(
            'SELECT doc FROM preset_states WHERE handle=$1 AND dir_key=$2 AND name=$3 AND namespace=$4',
            [p.handle, p.dir_key, p.name, namespace],
        );
        if (!r.rows.length) return null;
        const parsed = coerceJson(r.rows[0].doc);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
        return null;
    };

    tx.putPresetState = async (key, namespace, doc) => {
        const p = presetKeyToParams(key);
        // PERMISSIVE: no parent-exists precheck (matches FsTransaction,
        // SqliteTransaction, and MysqlTransaction; the schema's missing FK on
        // preset_states is the structural counterpart of this policy).
        await client.query(
            `INSERT INTO preset_states (handle, dir_key, name, namespace, doc) VALUES ($1, $2, $3, $4, $5::jsonb)
             ON CONFLICT (handle, dir_key, name, namespace) DO UPDATE SET doc = EXCLUDED.doc`,
            [p.handle, p.dir_key, p.name, namespace, JSON.stringify(doc)],
        );
    };

    tx.deletePresetState = async (key, namespace) => {
        const p = presetKeyToParams(key);
        const r = await client.query(
            'DELETE FROM preset_states WHERE handle=$1 AND dir_key=$2 AND name=$3 AND namespace=$4',
            [p.handle, p.dir_key, p.name, namespace],
        );
        return r.rowCount > 0;
    };

    tx.listPresetStateNamespaces = async (key) => {
        const p = presetKeyToParams(key);
        const r = await client.query(
            'SELECT namespace FROM preset_states WHERE handle=$1 AND dir_key=$2 AND name=$3',
            [p.handle, p.dir_key, p.name],
        );
        return r.rows.map((row) => row.namespace);
    };
}

export function registerWorldInfoHandler(tx) {
    const client = tx._client;

    async function listAllNames(handle) {
        const r = await client.query('SELECT name FROM worlds WHERE handle=$1', [handle]);
        return r.rows;
    }

    async function resolveCanonical(handle, requested) {
        const trimmed = String(requested || '').trim();
        if (!trimmed) return null;
        // Exact match first (cheap path; VARCHAR comparison in Postgres is
        // case-sensitive and byte-exact by default).
        const exactRows = await client.query(
            'SELECT name FROM worlds WHERE handle=$1 AND name=$2',
            [handle, trimmed],
        );
        if (exactRows.rows.length) return exactRows.rows[0].name;
        // Tolerant fallback via normalizeLookupText (NFC + variation-selector strip).
        const normalizedRequested = normalizeLookupText(trimmed);
        if (!normalizedRequested) return null;
        const all = await listAllNames(handle);
        const tolerant = all.find((r) => normalizeLookupText(r.name) === normalizedRequested);
        return tolerant ? tolerant.name : null;
    }

    tx._handlers.set('world', {
        async get(key) {
            const canonical = await resolveCanonical(key.handle, key.name);
            if (canonical == null) return null;
            const r = await client.query(
                'SELECT doc FROM worlds WHERE handle=$1 AND name=$2',
                [key.handle, canonical],
            );
            if (!r.rows.length) return null;
            const parsed = coerceJson(r.rows[0].doc);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
            return parsed;
        },
        async put(key, record) {
            assertSafeRepoNameShape(key.name, { field: 'world.name' });
            // Match FS behavior: if a tolerant match exists under a different
            // name, overwrite THAT one (so users can't accidentally create a
            // visually-identical-but-byte-distinct duplicate).
            const canonical = await resolveCanonical(key.handle, key.name);
            const targetName = canonical ?? String(key.name || '').trim();
            if (!targetName) throw new Error(`world put: invalid name ${key.name}`);
            await client.query(
                `INSERT INTO worlds (handle, name, doc, updated_at) VALUES ($1, $2, $3::jsonb, $4)
                 ON CONFLICT (handle, name) DO UPDATE SET doc = EXCLUDED.doc, updated_at = EXCLUDED.updated_at`,
                [key.handle, targetName, JSON.stringify(record.doc), Date.now()],
            );
        },
        async delete(key) {
            const canonical = await resolveCanonical(key.handle, key.name);
            if (canonical == null) return false;
            const r = await client.query(
                'DELETE FROM worlds WHERE handle=$1 AND name=$2',
                [key.handle, canonical],
            );
            return r.rowCount > 0;
        },
        async list(filter) {
            const r = await client.query(
                'SELECT name, doc FROM worlds WHERE handle=$1 ORDER BY name ASC',
                [filter.handle],
            );
            return r.rows.map((row) => {
                let parsed = {};
                const candidate = coerceJson(row.doc);
                if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
                    parsed = candidate;
                }
                const extensions = parsed.extensions && typeof parsed.extensions === 'object' && !Array.isArray(parsed.extensions)
                    ? parsed.extensions
                    : {};
                return {
                    key: { kind: 'world', handle: filter.handle, name: row.name },
                    name: parsed.name || row.name,
                    extensions,
                };
            });
        },
    });

    // Returns the canonical world name (no extension) — what WorldInfoRepo.get/save expect.
    tx.resolveWorldName = async (key) => resolveCanonical(key.handle, key.name);
}

export function registerNamedDocHandler(tx) {
    const client = tx._client;
    tx._handlers.set('named-doc', {
        async get(key) {
            const r = await client.query(
                'SELECT doc FROM named_docs WHERE handle=$1 AND bucket=$2 AND name=$3',
                [key.handle, key.bucket, key.name],
            );
            if (!r.rows.length) return null;
            const parsed = coerceJson(r.rows[0].doc);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
            return parsed;
        },
        async put(key, record) {
            assertSafeRepoNameShape(key.name, { field: 'named-doc.name' });
            await client.query(
                `INSERT INTO named_docs (handle, bucket, name, doc, updated_at) VALUES ($1, $2, $3, $4::jsonb, $5)
                 ON CONFLICT (handle, bucket, name) DO UPDATE SET doc = EXCLUDED.doc, updated_at = EXCLUDED.updated_at`,
                [key.handle, key.bucket, key.name, JSON.stringify(record.doc), Date.now()],
            );
        },
        async delete(key) {
            const r = await client.query(
                'DELETE FROM named_docs WHERE handle=$1 AND bucket=$2 AND name=$3',
                [key.handle, key.bucket, key.name],
            );
            return r.rowCount > 0;
        },
        async list(filter) {
            const r = await client.query(
                'SELECT name FROM named_docs WHERE handle=$1 AND bucket=$2 ORDER BY name ASC',
                [filter.handle, filter.bucket],
            );
            return r.rows.map((row) => ({
                key: {
                    kind: 'named-doc',
                    handle: filter.handle,
                    bucket: filter.bucket,
                    name: row.name,
                },
            }));
        },
    });
}

function groupKeyToParams(key) {
    return { handle: key.handle, id: String(key.id ?? '') };
}

export function registerGroupHandler(tx) {
    const client = tx._client;

    async function readRow(p) {
        const r = await client.query(
            'SELECT doc, created_at FROM groups_table WHERE handle=$1 AND id=$2',
            [p.handle, p.id],
        );
        return r.rows[0] || null;
    }

    tx._handlers.set('group', {
        async get(key) {
            const p = groupKeyToParams(key);
            const row = await readRow(p);
            if (!row) return null;
            const parsed = coerceJson(row.doc);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
            return parsed;
        },
        async put(key, record) {
            assertSafeRepoNameShape(key.id, { field: 'group.id' });
            const p = groupKeyToParams(key);
            if (!p.id) throw new Error(`group put: invalid id ${key.id}`);
            // Preserve existing created_at on overwrite; freshly set on first insert.
            const existing = await readRow(p);
            const now = Date.now();
            const updatedAt = record.updatedAt ?? now;
            const createdAt = record.createdAt ?? existing?.created_at ?? now;
            await client.query(
                `INSERT INTO groups_table (handle, id, doc, updated_at, created_at) VALUES ($1, $2, $3::jsonb, $4, $5)
                 ON CONFLICT (handle, id) DO UPDATE SET doc = EXCLUDED.doc, updated_at = EXCLUDED.updated_at`,
                [p.handle, p.id, JSON.stringify(record.doc), updatedAt, createdAt],
            );
        },
        async delete(key) {
            const p = groupKeyToParams(key);
            const r = await client.query(
                'DELETE FROM groups_table WHERE handle=$1 AND id=$2',
                [p.handle, p.id],
            );
            return r.rowCount > 0;
        },
        async list(filter) {
            const r = await client.query(
                'SELECT id FROM groups_table WHERE handle=$1 ORDER BY id ASC',
                [filter.handle],
            );
            return r.rows.map((row) => ({
                key: { kind: 'group', handle: filter.handle, id: row.id },
            }));
        },
    });

    // Composite read for /all — mirrors FsTransaction.listGroupsWithChatStats.
    // chat_size note: SQLite uses length(doc) which returns the JSON text
    // length. MySQL uses LENGTH(CAST(doc AS CHAR)); Postgres uses
    // LENGTH(doc::text). Both server-side serializations re-emit JSON with
    // extra whitespace (e.g. "a": 1 vs "a":1), so the integer differs from
    // both SQLite's length() and the original JSON.stringify length. The
    // frontend treats chat_size as a rough size indicator only (not
    // load-bearing), so the divergence is documented and accepted (same
    // caveat is documented in sqlite-engine-transaction.js and
    // mysql-engine-transaction.js).
    tx.listGroupsWithChatStats = async (filter) => {
        const groupQ = await client.query(
            'SELECT id, doc, created_at FROM groups_table WHERE handle=$1 ORDER BY id ASC',
            [filter.handle],
        );
        const chatQ = await client.query(
            `SELECT group_id, updated_at, LENGTH(doc::text) AS doc_len
             FROM chats WHERE handle=$1 AND is_group=1`,
            [filter.handle],
        );
        const chatByGroupId = new Map();
        for (const c of chatQ.rows) {
            const arr = chatByGroupId.get(c.group_id);
            if (arr) arr.push(c);
            else chatByGroupId.set(c.group_id, [c]);
        }
        const out = [];
        for (const row of groupQ.rows) {
            const group = coerceJson(row.doc);
            if (!group || typeof group !== 'object' || Array.isArray(group)) continue;
            // Prefer doc.date_added (set by GroupRepo.save on first write)
            // so the value survives FS↔DB migration. Fall back to row.created_at
            // for groups created before the GroupRepo started stamping date_added.
            const docDateAdded = (typeof group.date_added === 'number' && Number.isFinite(group.date_added))
                ? group.date_added
                : null;
            group.date_added = docDateAdded ?? row.created_at;
            group.create_date = new Date(group.date_added).toISOString();
            let chat_size = 0;
            let date_last_chat = 0;
            if (Array.isArray(group.chats)) {
                for (const chatId of group.chats) {
                    const matches = chatByGroupId.get(String(chatId));
                    if (!matches) continue;
                    for (const c of matches) {
                        chat_size += Number(c.doc_len) || 0;
                        if (c.updated_at > date_last_chat) date_last_chat = c.updated_at;
                    }
                }
            }
            group.date_last_chat = date_last_chat;
            group.chat_size = chat_size;
            out.push(group);
        }
        return out;
    };
}

export function registerStatsHandler(tx) {
    const client = tx._client;
    tx._handlers.set('stats', {
        async get(key) {
            const r = await client.query('SELECT doc FROM stats WHERE handle=$1', [key.handle]);
            if (!r.rows.length) return null;
            return coerceJson(r.rows[0].doc);
        },
        async put(key, record) {
            await client.query(
                `INSERT INTO stats (handle, doc, updated_at) VALUES ($1, $2::jsonb, $3)
                 ON CONFLICT (handle) DO UPDATE SET doc = EXCLUDED.doc, updated_at = EXCLUDED.updated_at`,
                [key.handle, JSON.stringify(record.doc), Date.now()],
            );
        },
        async delete(key) {
            const r = await client.query('DELETE FROM stats WHERE handle=$1', [key.handle]);
            return r.rowCount > 0;
        },
        list() { throw new Error('PgTransaction.list: stats is a singleton'); },
    });
}
