import { ChatRepo } from '../../../src/storage/repositories/chat-repo.js';
import { CONTRACT_HARNESSES } from '../harness/contract-harness.js';

describe.each(CONTRACT_HARNESSES)('ChatRepo on $name — rename + listRecent', ({ make }) => {
    let h, repo;
    beforeEach(async () => {
        h = await make();
        repo = new ChatRepo({ engine: h.engine });
    });
    afterEach(() => h.cleanup());

    test('rename moves the chat including state sidecars', async () => {
        await repo.save(h.handle, 'A', 'old', {}, [{ mes: 'x' }], null);
        await repo.setState(h.handle, 'A', 'old', 'ns', { v: 1 });

        await repo.rename(h.handle, 'A', 'old', 'new');

        expect(await repo.get(h.handle, 'A', 'old')).toBeNull();
        const moved = await repo.get(h.handle, 'A', 'new');
        expect(moved.body[0].mes).toBe('x');
        expect(await repo.getState(h.handle, 'A', 'new', 'ns')).toEqual({ v: 1 });
    });

    test('listRecent returns chats ordered by updatedAt desc', async () => {
        // Use a monotonic injected clock so the test is deterministic across engines.
        // FsEngine derives updatedAt from filesystem mtime (ms), whereas SqliteEngine
        // stores ChatRepo's `_now()` value (default: whole seconds). A 20ms sleep is
        // enough resolution for FS but lands on the same second under SQLite. Injecting
        // a tick-by-tick clock makes the ordering well-defined on both.
        let tick = 1_700_000_000_000; // ms; high enough to look like a real Date.now()
        const clockedRepo = new ChatRepo({ engine: h.engine, now: () => ++tick });
        await clockedRepo.save(h.handle, 'A', 'first', {}, [], null);
        await new Promise((r) => setTimeout(r, 5));
        await clockedRepo.save(h.handle, 'B', 'second', {}, [], null);

        const list = await clockedRepo.listRecent(h.handle, { limit: 10 });
        expect(list[0].key.name).toBe('second');
        expect(list[1].key.name).toBe('first');
    });

    test('listRecent respects limit', async () => {
        for (let i = 0; i < 5; i++) await repo.save(h.handle, 'A', `c${i}`, {}, [], null);
        const list = await repo.listRecent(h.handle, { limit: 2 });
        expect(list).toHaveLength(2);
    });

    test('rename refuses to overwrite an existing target', async () => {
        const { ConflictError } = await import('../../../src/storage/errors.js');
        await repo.save(h.handle, 'A', 'src', {}, [{ mes: 'src-msg' }], null);
        await repo.save(h.handle, 'A', 'dst', {}, [{ mes: 'dst-msg' }], null);

        await expect(repo.rename(h.handle, 'A', 'src', 'dst')).rejects.toThrow(ConflictError);

        const src = await repo.get(h.handle, 'A', 'src');
        const dst = await repo.get(h.handle, 'A', 'dst');
        expect(src.body[0].mes).toBe('src-msg');
        expect(dst.body[0].mes).toBe('dst-msg');
    });
});
