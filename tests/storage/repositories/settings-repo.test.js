import { CONTRACT_HARNESSES } from '../harness/contract-harness.js';
import { SettingsRepo } from '../../../src/storage/repositories/settings-repo.js';
import { NotFoundError } from '../../../src/storage/errors.js';

describe.each(CONTRACT_HARNESSES)('SettingsRepo on $name', ({ make }) => {
    let h, repo;
    beforeEach(async () => {
        h = await make();
        repo = new SettingsRepo({ engine: h.engine });
    });
    afterEach(() => h.cleanup());

    test('get returns null when no settings file', async () => {
        expect(await repo.get(h.handle)).toBeNull();
    });

    test('save writes whole doc; get reads it back', async () => {
        await repo.save(h.handle, { user_avatar: 'a.png', power_user: { x: 1 } });
        expect(await repo.get(h.handle)).toEqual({ user_avatar: 'a.png', power_user: { x: 1 } });
    });

    test('save overwrites existing doc', async () => {
        await repo.save(h.handle, { a: 1 });
        await repo.save(h.handle, { b: 2 });
        expect(await repo.get(h.handle)).toEqual({ b: 2 });
    });

    test('patch applies json-patch ops and returns new doc', async () => {
        await repo.save(h.handle, { a: 1, b: { c: 2 } });
        const next = await repo.patch(h.handle, [
            { op: 'replace', path: '/a', value: 9 },
            { op: 'add', path: '/b/d', value: 3 },
        ]);
        expect(next).toEqual({ a: 9, b: { c: 2, d: 3 } });
        expect(await repo.get(h.handle)).toEqual({ a: 9, b: { c: 2, d: 3 } });
    });

    test('patch throws when test op fails (signals 409 at endpoint)', async () => {
        await repo.save(h.handle, { a: 1 });
        await expect(repo.patch(h.handle, [{ op: 'test', path: '/a', value: 99 }]))
            .rejects.toThrow(/json patch test failed/);
    });

    test('patch on missing settings throws NotFoundError', async () => {
        await expect(repo.patch(h.handle, [{ op: 'replace', path: '/a', value: 1 }]))
            .rejects.toBeInstanceOf(NotFoundError);
    });
});
