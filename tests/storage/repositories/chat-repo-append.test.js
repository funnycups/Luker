import { ChatRepo } from '../../../src/storage/repositories/chat-repo.js';
import { ConflictError } from '../../../src/storage/errors.js';
import { CONTRACT_HARNESSES } from '../harness/contract-harness.js';

describe.each(CONTRACT_HARNESSES)('ChatRepo on $name — append', ({ make }) => {
    let h, repo;
    beforeEach(async () => {
        h = await make();
        repo = new ChatRepo({ engine: h.engine });
    });
    afterEach(() => h.cleanup());

    test('append on missing chat throws NotFoundError', async () => {
        await expect(
            repo.append(h.handle, 'Alice', 'ghost', [{ mes: 'x' }], 'INT'),
        ).rejects.toThrow();
    });

    test('append adds messages and rotates integrity', async () => {
        const { integrity: int1 } = await repo.save(h.handle, 'A', 'c', {}, [{ mes: 'm0' }], null);
        const { integrity: int2, accepted } = await repo.append(
            h.handle, 'A', 'c', [{ mes: 'm1' }, { mes: 'm2' }], int1,
        );
        expect(accepted).toBe(2);
        expect(int2).not.toBe(int1);

        const read = await repo.get(h.handle, 'A', 'c');
        expect(read.body.map((m) => m.mes)).toEqual(['m0', 'm1', 'm2']);
        expect(read.integrity).toBe(int2);
    });

    test('append with wrong integrity throws ConflictError', async () => {
        await repo.save(h.handle, 'A', 'c', {}, [], null);
        await expect(
            repo.append(h.handle, 'A', 'c', [{ mes: 'x' }], 'WRONG'),
        ).rejects.toThrow(ConflictError);
    });

    test('append skips a duplicate generation id (idempotent retry)', async () => {
        const { integrity: int1 } = await repo.save(h.handle, 'A', 'c', {}, [], null);
        const msg = { mes: 'reply', extra: { gen_id: 'g_abc' } };
        const { integrity: int2 } = await repo.append(h.handle, 'A', 'c', [msg], int1);
        const r2 = await repo.append(h.handle, 'A', 'c', [msg], int2);
        expect(r2.accepted).toBe(0);
        expect(r2.dedupedGenIds).toEqual(['g_abc']);
        const read = await repo.get(h.handle, 'A', 'c');
        expect(read.body).toHaveLength(1);
    });

    test('append accepts new messages alongside one already-seen gen_id', async () => {
        const msg1 = { mes: 'a', extra: { gen_id: 'g1' } };
        const msg2 = { mes: 'b', extra: { gen_id: 'g2' } };
        const { integrity: int1 } = await repo.save(h.handle, 'A', 'c', {}, [msg1], null);
        const r = await repo.append(h.handle, 'A', 'c', [msg1, msg2], int1);
        expect(r.accepted).toBe(1);
        expect(r.dedupedGenIds).toEqual(['g1']);
        const read = await repo.get(h.handle, 'A', 'c');
        expect(read.body.map((m) => m.mes)).toEqual(['a', 'b']);
    });
});
