import { ChatRepo } from '../../../src/storage/repositories/chat-repo.js';
import { CONTRACT_HARNESSES } from '../harness/contract-harness.js';

describe.each(CONTRACT_HARNESSES)('ChatRepo on $name — state (sidecar) operations', ({ make }) => {
    let h, repo;
    beforeEach(async () => {
        h = await make();
        repo = new ChatRepo({ engine: h.engine });
        await repo.save(h.handle, 'A', 'c', {}, [], null);
    });
    afterEach(() => h.cleanup());

    test('getState returns null when not yet written', async () => {
        const r = await repo.getState(h.handle, 'A', 'c', 'memory_graph__meta');
        expect(r).toBeNull();
    });

    test('setState then getState round-trips', async () => {
        await repo.setState(h.handle, 'A', 'c', 'memory_graph__meta', { anchors: [1] });
        const r = await repo.getState(h.handle, 'A', 'c', 'memory_graph__meta');
        expect(r).toEqual({ anchors: [1] });
    });

    test('getStateBatch returns multiple namespaces in one call', async () => {
        await repo.setState(h.handle, 'A', 'c', 'a', { v: 1 });
        await repo.setState(h.handle, 'A', 'c', 'b', { v: 2 });
        const r = await repo.getStateBatch(h.handle, 'A', 'c', ['a', 'b', 'missing']);
        expect(r).toEqual({ a: { v: 1 }, b: { v: 2 }, missing: null });
    });

    test('deleteState removes one namespace', async () => {
        await repo.setState(h.handle, 'A', 'c', 'a', { v: 1 });
        await repo.deleteState(h.handle, 'A', 'c', 'a');
        expect(await repo.getState(h.handle, 'A', 'c', 'a')).toBeNull();
    });

    test('deleting the chat removes all state namespaces', async () => {
        await repo.setState(h.handle, 'A', 'c', 'x', { v: 1 });
        await repo.setState(h.handle, 'A', 'c', 'y', { v: 2 });
        await repo.delete(h.handle, 'A', 'c');
        await repo.save(h.handle, 'A', 'c', {}, [], null);
        expect(await repo.getState(h.handle, 'A', 'c', 'x')).toBeNull();
        expect(await repo.getState(h.handle, 'A', 'c', 'y')).toBeNull();
    });

    test('setState on a non-existent chat throws NotFoundError', async () => {
        const { NotFoundError } = await import('../../../src/storage/errors.js');
        await expect(
            repo.setState(h.handle, 'A', 'ghost', 'ns', { v: 1 }),
        ).rejects.toThrow(NotFoundError);
    });
});
