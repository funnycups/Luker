// tests/i18n/create-scoped-i18n.test.js
// Wiring of public/scripts/i18n.js createScopedI18n: the module-level locale
// (read from localStorage 'language') drives the load order, and the core
// translator is the fallback. Synthetic tables only.
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';

let createScopedI18n;
let translate;
const descriptors = Object.fromEntries(['localStorage', 'MutationObserver'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
afterAll(() => {
    for (const [key, descriptor] of Object.entries(descriptors)) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
    }
});

beforeAll(async () => {
    Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        writable: true,
        value: { getItem: key => (key === 'language' ? 'zh-cn' : null), setItem: () => {}, removeItem: () => {} },
    });
    ({ createScopedI18n, translate } = await import('../../public/scripts/i18n.js'));
});

describe('createScopedI18n', () => {
    test('reads the plugin table in the active locale order before the core translator', () => {
        const scoped = createScopedI18n({
            'zh-tw': { 'k.both': 'tw', 'k.tw': 'tw only' },
            'zh-cn': { 'k.both': 'cn' },
            'en': { 'k.en': 'en only' },
        });
        expect(scoped.translate('k.both')).toBe('cn');
        expect(scoped.translate('k.tw')).toBe('tw only');
        expect(scoped.translate('k.en')).toBe(translate('k.en'));
        expect(scoped.has('k.en')).toBe(false);
        expect(scoped.t`k.both`).toBe('cn');
    });

    test('keeps the plugin table out of the core translator', () => {
        createScopedI18n({ 'zh-cn': { 'k.private': 'private' } });
        expect(translate('k.private')).toBe('k.private');
    });
});
