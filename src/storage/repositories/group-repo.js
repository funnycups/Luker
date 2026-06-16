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
        await this._engine.withTransaction(handle, (tx) =>
            tx.putResource(this._key(handle, id), { doc }));
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
