// tests/lib/plugin-i18n.test.js
import { describe, test, expect, jest, afterEach } from '@jest/globals';
import { createPluginI18n } from '../../public/scripts/lib/plugin-i18n.js';

const savedLuker = globalThis.Luker;
afterEach(() => {
    globalThis.Luker = savedLuker;
});

describe('createPluginI18n', () => {
    test('delegates to the context factory once, on first use', () => {
        const scoped = {
            t: jest.fn(() => 'T'),
            translate: jest.fn(() => 'X'),
            format: jest.fn(() => 'F'),
            has: jest.fn(() => true),
        };
        const factory = jest.fn(() => scoped);
        globalThis.Luker = { getContext: () => ({ createScopedI18n: factory }) };
        const tables = { 'zh-cn': { 'k.a': 'a' } };
        const i18n = createPluginI18n(tables);
        expect(factory).not.toHaveBeenCalled();
        expect(i18n.translate('k.a', 'k.key')).toBe('X');
        expect(i18n.format('k.f ${0}', 1)).toBe('F');
        expect(i18n.has('k.a')).toBe(true);
        expect(i18n.t`k.t ${1}`).toBe('T');
        expect(factory).toHaveBeenCalledTimes(1);
        expect(factory).toHaveBeenCalledWith(tables);
        expect(scoped.translate).toHaveBeenCalledWith('k.a', 'k.key');
        expect(scoped.format).toHaveBeenCalledWith('k.f ${0}', 1);
        expect(scoped.has).toHaveBeenCalledWith('k.a');
    });

    test('without a context factory every lookup returns the source text', () => {
        globalThis.Luker = { getContext: () => ({ createScopedI18n: null }) };
        const i18n = createPluginI18n({ 'zh-cn': { 'k.a': 'a' } });
        expect(i18n.translate('k.a')).toBe('k.a');
        expect(i18n.format('n=${0}', 3)).toBe('n=3');
        expect(i18n.t`n=${3}`).toBe('n=3');
        expect(i18n.has('k.a')).toBe(false);
    });

    test('a lookup before the context exists does not stop later lookups from translating', () => {
        globalThis.Luker = undefined;
        const tables = { 'zh-cn': { 'k.a': 'a' } };
        const i18n = createPluginI18n(tables);
        expect(i18n.translate('k.a')).toBe('k.a');
        expect(i18n.has('k.a')).toBe(false);
        const factory = jest.fn(own => ({
            t: () => '',
            translate: text => own['zh-cn'][text] || text,
            format: template => template,
            has: key => Object.hasOwn(own['zh-cn'], key),
        }));
        globalThis.Luker = { getContext: () => ({ createScopedI18n: factory }) };
        expect(i18n.translate('k.a')).toBe('a');
        expect(i18n.has('k.a')).toBe(true);
        expect(factory).toHaveBeenCalledTimes(1);
        expect(factory).toHaveBeenCalledWith(tables);
    });

    test('without a Luker global every lookup returns the source text', () => {
        globalThis.Luker = undefined;
        expect(createPluginI18n({ 'zh-cn': { 'k.a': 'a' } }).translate('k.a')).toBe('k.a');
    });
});
