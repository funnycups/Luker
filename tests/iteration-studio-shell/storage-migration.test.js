import { describe, test, expect, beforeEach, jest, beforeAll } from '@jest/globals';

// storage-migration imports i18n — mock as identity.
jest.unstable_mockModule('../../public/scripts/iteration-studio/i18n.js', () => ({
    i18n: (k) => k,
    i18nFormat: (k, ...args) => `${k}:${args.join('|')}`,
}));

let createStubAdapter;
let ensureStorageWipeOnce;
let __resetWipeFlagsForTest;

beforeAll(async () => {
    ({ createStubAdapter } = await import('./helpers/stub-adapter.js'));
    const mod = await import('../../public/scripts/iteration-studio/storage-migration.js');
    ensureStorageWipeOnce = mod.ensureStorageWipeOnce;
    __resetWipeFlagsForTest = mod.__resetWipeFlagsForTest;
});

beforeEach(() => { __resetWipeFlagsForTest(); });

describe('ensureStorageWipeOnce', () => {
    test('calls clearObsoleteSessions on first invocation per adapter', async () => {
        const a = createStubAdapter();
        await ensureStorageWipeOnce(a);
        expect(a._state.clearObsoleteCalled).toBe(1);
    });

    test('does not call on second invocation', async () => {
        const a = createStubAdapter();
        await ensureStorageWipeOnce(a);
        await ensureStorageWipeOnce(a);
        expect(a._state.clearObsoleteCalled).toBe(1);
    });

    test('different adapters get independent flags', async () => {
        const a = createStubAdapter();
        const b = { ...createStubAdapter(), id: 'other-stub' };
        await ensureStorageWipeOnce(a);
        await ensureStorageWipeOnce(b);
        expect(a._state.clearObsoleteCalled).toBe(1);
        expect(b._state.clearObsoleteCalled).toBe(1);
    });

    test('adapter without clearObsoleteSessions hook still sets flag without crashing', async () => {
        const a = createStubAdapter();
        delete a.clearObsoleteSessions;
        await expect(ensureStorageWipeOnce(a)).resolves.toBeUndefined();
    });
});
