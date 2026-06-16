import { CONTRACT_HARNESSES } from '../harness/contract-harness.js';
import { StatsRepo } from '../../../src/storage/repositories/stats-repo.js';

describe.each(CONTRACT_HARNESSES)('StatsRepo on $name', ({ make }) => {
    let h, repo;
    beforeEach(async () => {
        h = await make();
        repo = new StatsRepo({ engine: h.engine });
    });
    afterEach(() => h.cleanup());

    test('get returns null when no stats file', async () => {
        expect(await repo.get(h.handle)).toBeNull();
    });

    test('save then get round-trips the stats doc', async () => {
        const doc = { 'foo.png': { user_msg_count: 5 }, timestamp: 12345 };
        await repo.save(h.handle, doc);
        expect(await repo.get(h.handle)).toEqual(doc);
    });

    test('save overwrites', async () => {
        await repo.save(h.handle, { a: 1, timestamp: 1 });
        await repo.save(h.handle, { b: 2, timestamp: 2 });
        expect(await repo.get(h.handle)).toEqual({ b: 2, timestamp: 2 });
    });
});
