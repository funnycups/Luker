import { randomUUID } from 'node:crypto';
import _ from 'lodash';
import { ConflictError, NotFoundError } from '../errors.js';
import { assertWritable } from '../read-only-mode.js';
import { applyJsonPatch } from './json-patch.js';

export class ChatRepo {
    constructor({ engine, now = () => Math.floor(Date.now() / 1000) }) {
        this._engine = engine;
        this._now = now;
    }

    async get(handle, charDir, name, { isGroup = false, groupId } = {}) {
        return this._engine.withTransaction(handle, async (tx) => {
            return tx.getResource(this._key(handle, charDir, name, { isGroup, groupId }));
        });
    }

    async save(handle, charDir, name, header, messages, expectedIntegrity, { isGroup = false, groupId } = {}) {
        assertWritable();
        const key = this._key(handle, charDir, name, { isGroup, groupId });
        const newIntegrity = randomUUID();
        const now = this._now();
        return this._engine.withTransaction(handle, async (tx) => {
            const existing = await tx.getResource(key);
            if (expectedIntegrity !== null && expectedIntegrity !== undefined) {
                if (!existing) throw new NotFoundError('chat', { handle, charDir, name });
                if (existing.integrity !== expectedIntegrity) {
                    throw new ConflictError('integrity_mismatch', {
                        expected: expectedIntegrity,
                        actual: existing.integrity,
                    });
                }
            }
            await tx.putResource(key, {
                header,
                body: messages,
                integrity: newIntegrity,
                updatedAt: now,
                createdAt: existing?.createdAt ?? now,
            });
            return { integrity: newIntegrity };
        });
    }

    // Direct write that preserves the caller-supplied integrity / timestamps.
    // Use this only for migration: regular writes go through save() so the
    // engine rotates integrity and bumps updatedAt on every edit. The
    // MigrationRunner needs this escape hatch so a FS→DB copy doesn't reset
    // every chat's createdAt to "now" and invalidate cached integrity values.
    async saveRaw(handle, charDir, name, record, { isGroup = false, groupId } = {}) {
        assertWritable();
        const key = this._key(handle, charDir, name, { isGroup, groupId });
        return this._engine.withTransaction(handle, async (tx) =>
            tx.putResource(key, record));
    }

    async append(handle, charDir, name, newMessages, expectedIntegrity, { isGroup = false, groupId } = {}) {
        assertWritable();
        const key = this._key(handle, charDir, name, { isGroup, groupId });
        const newIntegrity = randomUUID();
        const now = this._now();
        return this._engine.withTransaction(handle, async (tx) => {
            const existing = await tx.getResource(key);
            if (!existing) throw new NotFoundError('chat', { handle, charDir, name });
            if (expectedIntegrity !== null && expectedIntegrity !== undefined) {
                if (existing.integrity !== expectedIntegrity) {
                    throw new ConflictError('integrity_mismatch', {
                        expected: expectedIntegrity,
                        actual: existing.integrity,
                    });
                }
            }
            const seenGenIds = new Set(
                existing.body
                    .map((m) => m?.extra?.gen_id)
                    .filter((id) => typeof id === 'string' && id.length > 0),
            );
            const accepted = [];
            const dedupedGenIds = [];
            for (const m of newMessages) {
                const gid = m?.extra?.gen_id;
                if (typeof gid === 'string' && gid.length > 0 && seenGenIds.has(gid)) {
                    dedupedGenIds.push(gid);
                    continue;
                }
                if (typeof gid === 'string' && gid.length > 0) seenGenIds.add(gid);
                accepted.push(m);
            }
            await tx.putResource(key, {
                header: existing.header,
                body: existing.body.concat(accepted),
                integrity: newIntegrity,
                updatedAt: now,
                createdAt: existing.createdAt,
            });
            return { integrity: newIntegrity, accepted: accepted.length, dedupedGenIds };
        });
    }

    async patch(handle, charDir, name, ops, expectedIntegrity, { isGroup = false, groupId } = {}) {
        assertWritable();
        const key = this._key(handle, charDir, name, { isGroup, groupId });
        const newIntegrity = randomUUID();
        const now = this._now();
        return this._engine.withTransaction(handle, async (tx) => {
            const existing = await tx.getResource(key);
            if (!existing) throw new NotFoundError('chat', { handle, charDir, name });
            if (expectedIntegrity !== null && expectedIntegrity !== undefined) {
                if (existing.integrity !== expectedIntegrity) {
                    throw new ConflictError('integrity_mismatch', {
                        expected: expectedIntegrity,
                        actual: existing.integrity,
                    });
                }
            }
            const docBefore = { header: existing.header, body: existing.body };
            const rewrittenOps = makeIdempotent(ops, docBefore);
            const docAfter = applyJsonPatch(docBefore, rewrittenOps);
            await tx.putResource(key, {
                header: docAfter.header,
                body: docAfter.body,
                integrity: newIntegrity,
                updatedAt: now,
                createdAt: existing.createdAt,
            });
            return { integrity: newIntegrity };
        });
    }

    async delete(handle, charDir, name, { isGroup = false, groupId } = {}) {
        assertWritable();
        const key = this._key(handle, charDir, name, { isGroup, groupId });
        await this._engine.withTransaction(handle, async (tx) => {
            await tx.deleteResource(key);
        });
    }

    async getState(handle, charDir, name, namespace, { isGroup = false, groupId } = {}) {
        const key = this._key(handle, charDir, name, { isGroup, groupId });
        return this._engine.withTransaction(handle, async (tx) => tx.getChatState(key, namespace));
    }

    async setState(handle, charDir, name, namespace, doc, { isGroup = false, groupId } = {}) {
        assertWritable();
        const key = this._key(handle, charDir, name, { isGroup, groupId });
        await this._engine.withTransaction(handle, async (tx) => {
            const existing = await tx.getResource(key);
            if (!existing) throw new NotFoundError('chat', { handle, charDir, name });
            await tx.putChatState(key, namespace, doc);
        });
    }

    async deleteState(handle, charDir, name, namespace, { isGroup = false, groupId } = {}) {
        assertWritable();
        const key = this._key(handle, charDir, name, { isGroup, groupId });
        await this._engine.withTransaction(handle, async (tx) => tx.deleteChatState(key, namespace));
    }

    async getStateBatch(handle, charDir, name, namespaces, { isGroup = false, groupId } = {}) {
        const key = this._key(handle, charDir, name, { isGroup, groupId });
        return this._engine.withTransaction(handle, async (tx) => {
            const out = {};
            for (const ns of namespaces) out[ns] = await tx.getChatState(key, ns);
            return out;
        });
    }

    async rename(handle, charDir, oldName, newName, { isGroup = false, groupId } = {}) {
        assertWritable();
        const oldKey = this._key(handle, charDir, oldName, { isGroup, groupId });
        const newKey = this._key(handle, charDir, newName, { isGroup, groupId });
        await this._engine.withTransaction(handle, async (tx) => {
            const existing = await tx.getResource(oldKey);
            if (!existing) throw new NotFoundError('chat', { handle, charDir, name: oldName });
            const conflict = await tx.getResource(newKey);
            if (conflict) {
                throw new ConflictError('rename_target_exists', { handle, charDir, name: newName });
            }
            const namespaces = await tx.listChatStateNamespaces(oldKey);
            const states = {};
            for (const ns of namespaces) states[ns] = await tx.getChatState(oldKey, ns);

            await tx.putResource(newKey, {
                header: existing.header,
                body: existing.body,
                integrity: existing.integrity,
                updatedAt: existing.updatedAt,
                createdAt: existing.createdAt,
            });
            for (const [ns, doc] of Object.entries(states)) {
                await tx.putChatState(newKey, ns, doc);
            }
            await tx.deleteResource(oldKey);
        });
    }

    async listRecent(handle, { limit = 50 } = {}) {
        return this._engine.withTransaction(handle, async (tx) => {
            return tx.listResources({ kind: 'chat', handle, orderBy: 'updatedAt', limit });
        });
    }

    // Filtered list helpers. Each one is a thin
    // shape around the engine-level filter contract so endpoints can avoid
    // direct fs scans.

    async listForCharacter(handle, charDir, { orderBy = 'updatedAt', limit } = {}) {
        return this._engine.withTransaction(handle, async (tx) =>
            tx.listResources({ kind: 'chat', handle, charDir, isGroup: false, orderBy, limit }));
    }

    async listForGroup(handle, groupId, { orderBy = 'updatedAt', limit } = {}) {
        return this._engine.withTransaction(handle, async (tx) =>
            tx.listResources({ kind: 'chat', handle, isGroup: true, groupId, orderBy, limit }));
    }

    async listAllGroupChats(handle, { orderBy = 'updatedAt', limit } = {}) {
        return this._engine.withTransaction(handle, async (tx) =>
            tx.listResources({ kind: 'chat', handle, isGroup: true, orderBy, limit }));
    }

    async listAll(handle, { orderBy = 'updatedAt', limit } = {}) {
        return this._engine.withTransaction(handle, async (tx) =>
            tx.listResources({ kind: 'chat', handle, orderBy, limit }));
    }

    // Drop every chat (and its cascaded state sidecars) under a character.
    // Used by /api/characters/delete with delete_chats=true so the db rows
    // don't outlive the avatar file in db modes.
    async deleteAllForCharacter(handle, charDir) {
        assertWritable();
        if (typeof charDir !== 'string' || !charDir) throw new Error('deleteAllForCharacter: charDir required');
        return this._engine.withTransaction(handle, async (tx) => {
            const entries = await tx.listResources({
                kind: 'chat', handle, charDir, isGroup: false,
            });
            for (const e of entries) {
                await tx.deleteResource({ kind: 'chat', handle, charDir, name: e.key.name, isGroup: false });
            }
            return entries.length;
        });
    }

    // Move every character chat from oldCharDir to newCharDir in a single
    // transaction. Used by /api/characters/rename so chats follow the
    // character to its new on-disk avatar name in db modes too.
    // Returns the number of chats moved (including their state sidecars).
    async renameCharDir(handle, oldCharDir, newCharDir) {
        assertWritable();
        if (typeof oldCharDir !== 'string' || !oldCharDir) throw new Error('renameCharDir: oldCharDir required');
        if (typeof newCharDir !== 'string' || !newCharDir) throw new Error('renameCharDir: newCharDir required');
        if (oldCharDir === newCharDir) return 0;
        return this._engine.withTransaction(handle, async (tx) => {
            const entries = await tx.listResources({
                kind: 'chat', handle, charDir: oldCharDir, isGroup: false,
            });
            if (entries.length === 0) return 0;

            // For each chat under oldCharDir: read full payload, migrate state
            // sidecars (we list ns then re-attach to the new key), then put
            // the chat under newCharDir, then delete the old. Order matters
            // because chat_states reference (handle, char_dir, name, ...).
            for (const e of entries) {
                const oldKey = { kind: 'chat', handle, charDir: oldCharDir, name: e.key.name, isGroup: false };
                const newKey = { kind: 'chat', handle, charDir: newCharDir, name: e.key.name, isGroup: false };
                const full = await tx.getResource(oldKey);
                if (full == null) continue;

                // Migrate state sidecars first by namespace.
                const namespaces = await tx.listChatStateNamespaces(oldKey);
                for (const ns of namespaces) {
                    const doc = await tx.getChatState(oldKey, ns);
                    if (doc !== null && doc !== undefined) {
                        // putChatState requires the new parent to exist; do that
                        // BEFORE writing the sidecar. We need an order:
                        //   1. write new parent chat
                        //   2. write new sidecars
                        //   3. delete old parent (which cascades old sidecars)
                        // Defer the sidecar writes until after step 1 by holding
                        // them in a Map; we'll write them next.
                        // (handled below)
                        e._sidecars = e._sidecars || new Map();
                        e._sidecars.set(ns, doc);
                    }
                }

                // 1. Write the chat under the new key.
                await tx.putResource(newKey, {
                    header: full.header,
                    body: full.body,
                    integrity: full.integrity,
                    updatedAt: full.updatedAt,
                    createdAt: full.createdAt,
                });
                // 2. Replay sidecars under the new key.
                if (e._sidecars) {
                    for (const [ns, doc] of e._sidecars) {
                        await tx.putChatState(newKey, ns, doc);
                    }
                }
                // 3. Drop the old chat (cascades old sidecars).
                await tx.deleteResource(oldKey);
            }
            return entries.length;
        });
    }

    // Lightweight "chat info" — body length, last message preview, header
    // chat_metadata. Used by /api/characters/chats?metadata=1 and
    // /api/chats/recent. Implemented as a Repo.get + projection because
    // engines all hold the full body in memory after a get anyway; this
    // keeps a single shape across engines without per-engine SQL.
    async getInfo(handle, charDir, name, { isGroup = false, groupId } = {}) {
        const chat = await this.get(handle, charDir, name, { isGroup, groupId });
        if (chat == null) return null;
        const body = Array.isArray(chat.body) ? chat.body : [];
        const lastMessage = body.length > 0 ? body[body.length - 1] : null;
        // Approximate jsonl byte size: header line + one line per message,
        // utf-8 encoded. Within a few percent of the on-disk file (whitespace
        // and trailing-newline differences) — used only as a UI hint.
        const headerLine = chat.header ? JSON.stringify(chat.header) : '';
        const bodyLines = body.map((m) => JSON.stringify(m)).join('\n');
        const serialized = bodyLines ? `${headerLine}\n${bodyLines}` : headerLine;
        const byteSize = Buffer.byteLength(serialized, 'utf8');
        return {
            handle,
            charDir,
            name,
            isGroup: !!isGroup,
            groupId: groupId || undefined,
            messageCount: body.length,
            byteSize,
            lastMessage,
            chatMetadata: chat.header?.chat_metadata ?? {},
            updatedAt: chat.updatedAt,
            createdAt: chat.createdAt,
            integrity: chat.integrity,
        };
    }

    // Patch the in-place `chat_metadata` block of an existing chat header
    // without rewriting body messages. Single round-trip transaction so the
    // integrity check + merge + put run atomically. Returns the new integrity.
    async updateChatMetadata(handle, charDir, name, metadataPatch, expectedIntegrity, { isGroup = false, groupId } = {}) {
        assertWritable();
        const key = this._key(handle, charDir, name, { isGroup, groupId });
        const newIntegrity = randomUUID();
        const now = this._now();
        return this._engine.withTransaction(handle, async (tx) => {
            const existing = await tx.getResource(key);
            if (!existing) throw new NotFoundError('chat', { handle, charDir, name });
            if (expectedIntegrity !== null && expectedIntegrity !== undefined) {
                if (existing.integrity !== expectedIntegrity) {
                    throw new ConflictError('integrity_mismatch', {
                        expected: expectedIntegrity,
                        actual: existing.integrity,
                    });
                }
            }
            const header = existing.header ?? {};
            const merged = {
                ...header,
                chat_metadata: {
                    ...(header.chat_metadata ?? {}),
                    ...(metadataPatch ?? {}),
                },
            };
            await tx.putResource(key, {
                header: merged,
                body: existing.body,
                integrity: newIntegrity,
                updatedAt: now,
                createdAt: existing.createdAt,
            });
            return { integrity: newIntegrity };
        });
    }

    // Substring search over chat body messages. Returns chats whose at least
    // one message contains the query (case-insensitive) anywhere in the
    // text of `mes`. Lightweight: walks bodies in-memory rather than asking
    // each engine for full-text search (sqlite has FTS but mysql/pg would
    // need separate tablespaces).
    async searchByContent(handle, query, { charDir, groupId, isGroup, maxResults = 200 } = {}) {
        const needle = String(query ?? '').toLowerCase();
        if (!needle) return [];
        return this._engine.withTransaction(handle, async (tx) => {
            const filter = { kind: 'chat', handle };
            if (typeof charDir === 'string') filter.charDir = charDir;
            if (typeof isGroup === 'boolean') filter.isGroup = isGroup;
            if (typeof groupId === 'string') filter.groupId = groupId;
            filter.orderBy = 'updatedAt';
            const entries = await tx.listResources(filter);

            const out = [];
            for (const e of entries) {
                if (out.length >= maxResults) break;
                const full = await tx.getResource(e.key);
                if (!full || !Array.isArray(full.body)) continue;
                const hits = [];
                for (let i = 0; i < full.body.length; i++) {
                    const msg = full.body[i];
                    const text = String(msg?.mes ?? '');
                    if (text.toLowerCase().includes(needle)) {
                        hits.push({ messageIndex: i, text });
                    }
                }
                if (hits.length > 0) {
                    out.push({
                        handle,
                        charDir: e.key.charDir,
                        name: e.key.name,
                        isGroup: !!e.key.isGroup,
                        groupId: e.key.groupId,
                        snippets: hits,
                        updatedAt: e.updatedAt,
                    });
                }
            }
            return out;
        });
    }

    async listStateNamespaces(handle, charDir, name, { isGroup = false, groupId } = {}) {
        const key = this._key(handle, charDir, name, { isGroup, groupId });
        return this._engine.withTransaction(handle, (tx) => tx.listChatStateNamespaces(key));
    }

    _key(handle, charDir, name, { isGroup, groupId }) {
        return { kind: 'chat', handle, charDir, name, isGroup, groupId };
    }
}

function makeIdempotent(ops, doc) {
    return ops.map((op) => {
        if (op.op !== 'add') return op;
        const m = op.path.match(/^\/body\/(\d+)$/);
        if (!m) return op;
        const idx = Number(m[1]);
        const existing = doc.body[idx];
        if (existing !== undefined && _.isEqual(existing, op.value)) {
            return { op: 'test', path: op.path, value: op.value };
        }
        return op;
    });
}
