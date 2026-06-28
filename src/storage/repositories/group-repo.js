import { assertWritable } from '../read-only-mode.js';

export class GroupRepo {
    constructor({ engine }) {
        this._engine = engine;
    }

    _key(handle, id) {
        return { kind: 'group', handle, id: String(id) };
    }

    async get(handle, id) {
        return this._engine.withTransaction(handle, (tx) => tx.getResource(this._key(handle, id)));
    }

    async save(handle, id, doc) {
        assertWritable();
        await this._engine.withTransaction(handle, async (tx) => {
            // Stamp doc.date_added on first save so the value survives FS↔DB
            // migration: FS reports file birthtime and DB reports row
            // created_at, neither of which round-trip through a copy. Once
            // stored in the doc, both engines surface it verbatim via
            // listGroupsWithChatStats.
            if (typeof doc?.date_added !== 'number' || !Number.isFinite(doc.date_added)) {
                const existing = await tx.getResource(this._key(handle, id));
                const stamped = (typeof existing?.date_added === 'number' && Number.isFinite(existing.date_added))
                    ? existing.date_added
                    : Date.now();
                doc = { ...doc, date_added: stamped };
            }
            await tx.putResource(this._key(handle, id), { doc });
        });
    }

    async delete(handle, id) {
        assertWritable();
        return this._engine.withTransaction(handle, async (tx) => {
            const group = await tx.getResource(this._key(handle, id));
            if (group == null) return { deleted: false, chatsDeleted: 0 };
            let chatsDeleted = 0;
            if (Array.isArray(group.chats)) {
                for (const chatId of group.chats) {
                    const removed = await tx.deleteResource({
                        kind: 'chat',
                        handle,
                        isGroup: true,
                        groupId: chatId,
                    });
                    if (removed) chatsDeleted++;
                }
            }
            const groupRemoved = await tx.deleteResource(this._key(handle, id));
            return { deleted: groupRemoved, chatsDeleted };
        });
    }

    async list(handle) {
        return this._engine.withTransaction(handle, (tx) =>
            tx.listResources({ kind: 'group', handle }));
    }

    async listWithChatStats(handle) {
        return this._engine.withTransaction(handle, (tx) =>
            tx.listGroupsWithChatStats({ kind: 'group', handle }));
    }
}
