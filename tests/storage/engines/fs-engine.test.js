import fs from 'node:fs';
import path from 'node:path';
import { makeTempFsEngine } from '../harness/fs-harness.js';

describe('FsEngine — chat resource basics', () => {
    let h;
    beforeEach(async () => { h = await makeTempFsEngine(); });
    afterEach(() => h.cleanup());

    test('getResource returns null when chat file does not exist', async () => {
        await h.engine.withTransaction(h.handle, async (tx) => {
            const result = await tx.getResource({
                kind: 'chat', handle: h.handle, charDir: 'Alice', name: 'nope',
            });
            expect(result).toBeNull();
        });
    });

    test('putResource writes a chat that getResource reads back identically', async () => {
        const header = { user_name: 'U', chat_metadata: { variables: {} } };
        const messages = [
            { name: 'U', is_user: true, mes: 'hi' },
            { name: 'C', is_user: false, mes: 'hello' },
        ];

        await h.engine.withTransaction(h.handle, async (tx) => {
            await tx.putResource(
                { kind: 'chat', handle: h.handle, charDir: 'Alice', name: 'chat1' },
                { header, body: messages, integrity: 'INT1', updatedAt: 100, createdAt: 100 },
            );
        });

        const written = fs.readFileSync(
            path.join(h.chatsDir, 'Alice', 'chat1.jsonl'),
            'utf-8',
        );
        const lines = written.trim().split('\n').map((l) => JSON.parse(l));
        expect(lines).toHaveLength(3);
        expect(lines[0].user_name).toBe('U');
        expect(lines[0].chat_metadata.integrity).toBe('INT1');
        expect(lines[1]).toEqual(messages[0]);
        expect(lines[2]).toEqual(messages[1]);

        await h.engine.withTransaction(h.handle, async (tx) => {
            const read = await tx.getResource({
                kind: 'chat', handle: h.handle, charDir: 'Alice', name: 'chat1',
            });
            expect(read.header.user_name).toBe('U');
            expect(read.body).toEqual(messages);
            expect(read.integrity).toBe('INT1');
        });
    });

    test('putResourceIfMatch refuses when stored integrity differs', async () => {
        const key = { kind: 'chat', handle: h.handle, charDir: 'A', name: 'c' };
        await h.engine.withTransaction(h.handle, async (tx) => {
            await tx.putResource(key, {
                header: {}, body: [], integrity: 'OLD', updatedAt: 1, createdAt: 1,
            });
        });
        await h.engine.withTransaction(h.handle, async (tx) => {
            const r = await tx.putResourceIfMatch(key, 'WRONG', {
                header: {}, body: [], integrity: 'NEW', updatedAt: 2, createdAt: 1,
            });
            expect(r.updated).toBe(false);
        });
        await h.engine.withTransaction(h.handle, async (tx) => {
            const read = await tx.getResource(key);
            expect(read.integrity).toBe('OLD');
        });
    });

    test('putResourceIfMatch with expectedIntegrity=null only creates new', async () => {
        const key = { kind: 'chat', handle: h.handle, charDir: 'A', name: 'fresh' };
        await h.engine.withTransaction(h.handle, async (tx) => {
            const r = await tx.putResourceIfMatch(key, null, {
                header: {}, body: [], integrity: 'INT', updatedAt: 1, createdAt: 1,
            });
            expect(r.updated).toBe(true);
        });
        await h.engine.withTransaction(h.handle, async (tx) => {
            const r2 = await tx.putResourceIfMatch(key, null, {
                header: {}, body: [], integrity: 'INT2', updatedAt: 2, createdAt: 1,
            });
            expect(r2.updated).toBe(false);
        });
    });

    test('deleteResource removes the chat file', async () => {
        const key = { kind: 'chat', handle: h.handle, charDir: 'A', name: 'doomed' };
        await h.engine.withTransaction(h.handle, async (tx) => {
            await tx.putResource(key, {
                header: {}, body: [], integrity: 'X', updatedAt: 1, createdAt: 1,
            });
        });
        expect(fs.existsSync(path.join(h.chatsDir, 'A', 'doomed.jsonl'))).toBe(true);
        await h.engine.withTransaction(h.handle, async (tx) => {
            await tx.deleteResource(key);
        });
        expect(fs.existsSync(path.join(h.chatsDir, 'A', 'doomed.jsonl'))).toBe(false);
    });

    test('chat deleteResource returns true when present', async () => {
        const key = { kind: 'chat', handle: h.handle, charDir: 'TestChar', name: 'chat1' };
        await h.engine.withTransaction(h.handle, (tx) =>
            tx.putResource(key, {
                header: { chat_metadata: {} }, body: [], integrity: 'abc', updatedAt: 1234, createdAt: 1234,
            }));
        const result = await h.engine.withTransaction(h.handle, (tx) => tx.deleteResource(key));
        expect(result).toBe(true);
    });

    test('chat deleteResource returns false when missing', async () => {
        const result = await h.engine.withTransaction(h.handle, (tx) =>
            tx.deleteResource({ kind: 'chat', handle: h.handle, charDir: 'TestChar', name: 'Nope' }));
        expect(result).toBe(false);
    });

    test('putResourceIfMatch succeeds when stored integrity matches', async () => {
        const key = { kind: 'chat', handle: h.handle, charDir: 'A', name: 'm' };
        await h.engine.withTransaction(h.handle, async (tx) => {
            await tx.putResource(key, {
                header: {}, body: [], integrity: 'V1', updatedAt: 1, createdAt: 1,
            });
        });
        await h.engine.withTransaction(h.handle, async (tx) => {
            const r = await tx.putResourceIfMatch(key, 'V1', {
                header: {}, body: [{ mes: 'hi' }], integrity: 'V2', updatedAt: 2, createdAt: 1,
            });
            expect(r.updated).toBe(true);
        });
        await h.engine.withTransaction(h.handle, async (tx) => {
            const read = await tx.getResource(key);
            expect(read.integrity).toBe('V2');
            expect(read.body).toEqual([{ mes: 'hi' }]);
        });
    });
});
