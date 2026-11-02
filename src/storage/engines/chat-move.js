import { ConflictError } from '../errors.js';
import { assertSafeRepoNameShape } from '../name-validation.js';
import { chatLocation, parseChatDocument, parseChatJson } from './chat-record.js';

// Native rows stay transaction-private; ordinary resource records carry no copy data.
export function registerSqlChatMove(tx, { readParent, readStates, insertParent, insertState, deleteParent }) {
    const snapshots = new WeakMap();
    const select = async key => {
        const row = await readParent(key);
        if (row === null) return null;
        const parsed = parseChatDocument(row.doc, key);
        const states = (await readStates(key)).sort((a, b) => a.namespace < b.namespace ? -1 : a.namespace > b.namespace ? 1 : 0);
        return {
            key: { ...key }, row,
            record: { key, header: parsed.header, body: parsed.body, integrity: row.integrity ?? '', updatedAt: row.updated_at, createdAt: row.created_at },
            states: states.map(state => ({ ...state, value: parseChatJson(state.doc, chatLocation(key, state.namespace)) })),
        };
    };
    const assertSourceUnchanged = async snapshot => {
        const current = await select(snapshot.key);
        if (current === null || ['doc', 'integrity', 'updated_at', 'created_at'].some(field => current.row[field] !== snapshot.row[field])
            || current.states.length !== snapshot.states.length
            || current.states.some((state, index) => state.namespace !== snapshot.states[index].namespace || state.doc !== snapshot.states[index].doc)) {
            throw new ConflictError('rename_source_changed', snapshot.key);
        }
    };
    tx.captureChatMove = async key => {
        const snapshot = await select(key);
        if (snapshot === null) return null;
        const token = Object.freeze({});
        snapshots.set(token, snapshot);
        return token;
    };
    tx.publishChatMove = async (key, token) => {
        const snapshot = snapshots.get(token);
        if (key.isGroup) {
            assertSafeRepoNameShape(key.groupId ?? key.name, { field: 'chat.groupId' });
        } else {
            assertSafeRepoNameShape(key.charDir, { field: 'chat.charDir' });
            assertSafeRepoNameShape(key.name, { field: 'chat.name' });
        }
        await assertSourceUnchanged(snapshot);
        if (!await insertParent(key, snapshot.row)) return { updated: false };
        for (const state of snapshot.states) {
            if (!await insertState(key, state)) throw new ConflictError('rename_target_exists', { ...key, namespace: state.namespace });
        }
        return { updated: true };
    };
    tx.deleteChatMoveSource = async token => {
        const snapshot = snapshots.get(token);
        await assertSourceUnchanged(snapshot);
        await deleteParent(snapshot.key);
        snapshots.delete(token);
    };
}
