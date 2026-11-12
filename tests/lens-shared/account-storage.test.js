// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, beforeEach } from '@jest/globals';

import { accountScopedStorage } from '../../public/scripts/lens-shared/account-storage.js';
import { accountLocalStorage, currentAccountHandle } from '../../public/scripts/lens-shared/current-account.js';

function createMemoryStorage() {
    const map = new Map();
    return {
        map,
        getItem(key) {
            return map.has(key) ? map.get(key) : null;
        },
        setItem(key, value) {
            map.set(key, String(value));
        },
        removeItem(key) {
            map.delete(key);
        },
    };
}

describe('lens-shared account-storage and current-account', () => {
    let fakeStorage;

    beforeEach(() => {
        fakeStorage = createMemoryStorage();
        globalThis.localStorage = fakeStorage;
        globalThis.Luker = {
            getContext: () => ({
                accountsEnabled: false,
                currentUser: null,
                settingsReady: false,
            }),
        };
    });

    test('accountsEnabled: true + missing handle -> getItem returns null and setItem/removeItem are no-ops (never writes unsuffixed key)', () => {
        globalThis.Luker = {
            getContext: () => ({
                accountsEnabled: true,
                currentUser: null,
                settingsReady: true,
            }),
        };

        expect(currentAccountHandle()).toBeNull();

        const scoped = accountLocalStorage();
        expect(scoped.getItem('workbench.prefs.v1')).toBeNull();
        scoped.setItem('workbench.prefs.v1', '{"a":1}');
        expect(fakeStorage.map.size).toBe(0);
        expect(fakeStorage.getItem('workbench.prefs.v1')).toBeNull();
        scoped.removeItem('workbench.prefs.v1');
        expect(fakeStorage.map.size).toBe(0);
    });

    test('accountsEnabled: true + handle "alice" -> reads/writes/removes <key>::alice', () => {
        globalThis.Luker = {
            getContext: () => ({
                accountsEnabled: true,
                currentUser: { handle: 'alice' },
                settingsReady: true,
            }),
        };

        expect(currentAccountHandle()).toBe('alice');

        const scoped = accountLocalStorage();
        scoped.setItem('workbench.prefs.v1', '{"theme":"dark"}');
        expect(fakeStorage.getItem('workbench.prefs.v1::alice')).toBe('{"theme":"dark"}');
        expect(fakeStorage.getItem('workbench.prefs.v1')).toBeNull();
        expect(scoped.getItem('workbench.prefs.v1')).toBe('{"theme":"dark"}');

        scoped.removeItem('workbench.prefs.v1');
        expect(fakeStorage.getItem('workbench.prefs.v1::alice')).toBeNull();
    });

    test('accountsEnabled: false + settingsReady: true -> uses "default-user"', () => {
        globalThis.Luker = {
            getContext: () => ({
                accountsEnabled: false,
                currentUser: null,
                settingsReady: true,
            }),
        };

        expect(currentAccountHandle()).toBe('default-user');

        const scoped = accountLocalStorage();
        scoped.setItem('memory-lens.state', 'ok');
        expect(fakeStorage.getItem('memory-lens.state::default-user')).toBe('ok');
        expect(scoped.getItem('memory-lens.state')).toBe('ok');
    });

    test('accountsEnabled: false + settingsReady: false -> handle is null and storage is a no-op', () => {
        expect(currentAccountHandle()).toBeNull();
        const scoped = accountLocalStorage();
        scoped.setItem('k', 'v');
        expect(fakeStorage.map.size).toBe(0);
        expect(scoped.getItem('k')).toBeNull();
    });

    test('accountScopedStorage supports injected storage + handle getter independently', () => {
        let handle = null;
        const storage = accountScopedStorage(fakeStorage, () => handle);
        storage.setItem('foo', 'bar');
        expect(fakeStorage.map.size).toBe(0);

        handle = 'bob';
        storage.setItem('foo', 'bar');
        expect(fakeStorage.getItem('foo::bob')).toBe('bar');
        expect(storage.getItem('foo')).toBe('bar');
    });
});
