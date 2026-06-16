import { makeTempFsEngine } from '../harness/fs-harness.js';

describe('FsEngine — listResources', () => {
    let h;
    beforeEach(async () => { h = await makeTempFsEngine(); });
    afterEach(() => h.cleanup());

    async function makeChat(charDir, name, integrity) {
        await h.engine.withTransaction(h.handle, async (tx) => {
            await tx.putResource(
                { kind: 'chat', handle: 'u', charDir, name },
                { header: {}, body: [], integrity, updatedAt: 1, createdAt: 1 },
            );
        });
    }

    test('lists all chats for a handle across char dirs', async () => {
        await makeChat('A', 'c1', 'I1');
        await makeChat('A', 'c2', 'I2');
        await makeChat('B', 'c3', 'I3');

        await h.engine.withTransaction(h.handle, async (tx) => {
            const list = await tx.listResources({ kind: 'chat', handle: 'u' });
            const keys = list.map((r) => `${r.key.charDir}/${r.key.name}`).sort();
            expect(keys).toEqual(['A/c1', 'A/c2', 'B/c3']);
        });
    });

    test('respects limit', async () => {
        await makeChat('A', 'c1', 'I1');
        await makeChat('A', 'c2', 'I2');
        await makeChat('A', 'c3', 'I3');

        await h.engine.withTransaction(h.handle, async (tx) => {
            const list = await tx.listResources({ kind: 'chat', handle: 'u', limit: 2 });
            expect(list).toHaveLength(2);
        });
    });

    test('orderBy=updatedAt returns most-recently-modified first', async () => {
        await makeChat('A', 'old', 'I1');
        await new Promise((r) => setTimeout(r, 20));
        await makeChat('A', 'new', 'I2');

        await h.engine.withTransaction(h.handle, async (tx) => {
            const list = await tx.listResources({
                kind: 'chat', handle: 'u', orderBy: 'updatedAt',
            });
            expect(list[0].key.name).toBe('new');
            expect(list[1].key.name).toBe('old');
        });
    });

    test('returns empty array when handle has no chats', async () => {
        await h.engine.withTransaction(h.handle, async (tx) => {
            const list = await tx.listResources({ kind: 'chat', handle: 'u' });
            expect(list).toEqual([]);
        });
    });
});
