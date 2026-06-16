import { ChatRepo } from '../../../src/storage/repositories/chat-repo.js';
import { ConflictError } from '../../../src/storage/errors.js';
import { CONTRACT_HARNESSES } from '../harness/contract-harness.js';

describe.each(CONTRACT_HARNESSES)('ChatRepo on $name — patch', ({ make }) => {
    let h, repo;
    beforeEach(async () => {
        h = await make();
        repo = new ChatRepo({ engine: h.engine });
    });
    afterEach(() => h.cleanup());

    async function setup(initialBody = []) {
        const { integrity } = await repo.save(h.handle, 'A', 'c', { chat_metadata: {} }, initialBody, null);
        return integrity;
    }

    test('patch replaces a message field and rotates integrity', async () => {
        const int1 = await setup([{ name: 'C', mes: 'old' }]);
        const { integrity: int2 } = await repo.patch(h.handle, 'A', 'c', [
            { op: 'replace', path: '/body/0/mes', value: 'new' },
        ], int1);
        expect(int2).not.toBe(int1);
        const read = await repo.get(h.handle, 'A', 'c');
        expect(read.body[0].mes).toBe('new');
    });

    test('patch with wrong integrity throws ConflictError without applying', async () => {
        const int1 = await setup([{ mes: 'old' }]);
        await expect(
            repo.patch(h.handle, 'A', 'c', [{ op: 'replace', path: '/body/0/mes', value: 'new' }], 'WRONG'),
        ).rejects.toThrow(ConflictError);
        const read = await repo.get(h.handle, 'A', 'c');
        expect(read.body[0].mes).toBe('old');
    });

    test('add op targeting an existing index with equal value is rewritten to test (idempotent)', async () => {
        const int1 = await setup([{ name: 'U', mes: 'hi' }]);
        const { integrity: int2 } = await repo.patch(h.handle, 'A', 'c', [
            { op: 'add', path: '/body/0', value: { name: 'U', mes: 'hi' } },
        ], int1);
        const read = await repo.get(h.handle, 'A', 'c');
        expect(read.body).toHaveLength(1);
        expect(read.body[0].mes).toBe('hi');
        expect(int2).not.toBe(int1);
    });

    test('add op targeting a fresh index appends', async () => {
        const int1 = await setup([{ mes: 'a' }]);
        await repo.patch(h.handle, 'A', 'c', [
            { op: 'add', path: '/body/1', value: { mes: 'b' } },
        ], int1);
        const read = await repo.get(h.handle, 'A', 'c');
        expect(read.body.map((m) => m.mes)).toEqual(['a', 'b']);
    });

    test('patch on header works (e.g. /header/chat_metadata/variables/foo)', async () => {
        const int1 = await setup([]);
        await repo.patch(h.handle, 'A', 'c', [
            { op: 'add', path: '/header/chat_metadata/variables/foo', value: 'bar' },
        ], int1);
        const read = await repo.get(h.handle, 'A', 'c');
        expect(read.header.chat_metadata.variables.foo).toBe('bar');
    });
});
