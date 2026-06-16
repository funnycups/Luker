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
