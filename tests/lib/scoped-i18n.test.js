// tests/lib/scoped-i18n.test.js
import { describe, test, expect, jest } from '@jest/globals';
import { buildScopedI18n } from '../../public/scripts/lib/scoped-i18n.js';

const TABLES = {
    'zh-tw': { 'k.both': 'tw-both', 'k.twOnly': 'tw-only', 'k.empty': 'tw-empty' },
    'zh-cn': { 'k.both': 'cn-both', 'k.empty': '', 'k.tpl ${0} of ${1}': 'cn ${1} / ${0}' },
};

function make(tables = TABLES, loadOrder = ['zh-tw', 'zh-cn']) {
    const fallback = jest.fn((text, key) => `core:${key || text}`);
    return { scoped: buildScopedI18n({ tables, loadOrder, fallback }), fallback };
}

describe('buildScopedI18n', () => {
    test('the active locale entry wins over the fallback locale entry', () => {
        const { scoped, fallback } = make();
        expect(scoped.translate('k.both')).toBe('cn-both');
        expect(fallback).not.toHaveBeenCalled();
    });

    test('a key defined only for the fallback locale resolves from it', () => {
        expect(make().scoped.translate('k.twOnly')).toBe('tw-only');
    });

    test('a missing key goes to the fallback translator with the original arguments', () => {
        const { scoped, fallback } = make();
        expect(scoped.translate('k.none')).toBe('core:k.none');
        expect(fallback).toHaveBeenLastCalledWith('k.none', null);
        expect(scoped.translate('Shown text', 'k.none2')).toBe('core:k.none2');
        expect(fallback).toHaveBeenLastCalledWith('Shown text', 'k.none2');
    });

    test('an explicit key is looked up instead of the text', () => {
        expect(make().scoped.translate('Shown text', 'k.both')).toBe('cn-both');
    });

    test('an empty active-locale entry falls through to the fallback translator', () => {
        const { scoped, fallback } = make();
        expect(scoped.translate('k.empty')).toBe('core:k.empty');
        expect(fallback).toHaveBeenLastCalledWith('k.empty', null);
    });

    test('tables outside the load order are ignored', () => {
        const { scoped } = make(TABLES, ['zh-cn']);
        expect(scoped.translate('k.twOnly')).toBe('core:k.twOnly');
    });

    test('t builds the indexed key and fills the values', () => {
        const { scoped } = make();
        expect(scoped.t`k.tpl ${'a'} of ${'b'}`).toBe('cn b / a');
    });

    test('format translates the template and fills placeholders', () => {
        const { scoped } = make();
        expect(scoped.format('k.tpl ${0} of ${1}', 'a', 'b')).toBe('cn b / a');
        expect(scoped.format('k.miss ${0}', 'x')).toBe('core:k.miss x');
    });

    test('has reports non-empty entries in the load order only', () => {
        const { scoped } = make();
        expect(scoped.has('k.both')).toBe(true);
        expect(scoped.has('k.twOnly')).toBe(true);
        expect(scoped.has('k.empty')).toBe(false);
        expect(scoped.has('k.none')).toBe(false);
    });

    test('tables are copied at creation', () => {
        const tables = { 'zh-cn': { 'k.a': 'before' } };
        const { scoped } = make(tables, ['zh-cn']);
        tables['zh-cn']['k.a'] = 'after';
        tables['zh-cn']['k.b'] = 'added';
        expect(scoped.translate('k.a')).toBe('before');
        expect(scoped.has('k.b')).toBe(false);
    });

    test('non-string values and missing tables are ignored', () => {
        expect(make({ 'zh-cn': { 'k.a': 1 } }, ['zh-cn']).scoped.translate('k.a')).toBe('core:k.a');
        expect(make(null, ['zh-cn']).scoped.translate('k.a')).toBe('core:k.a');
    });

    test('the returned translator is frozen', () => {
        expect(Object.isFrozen(make().scoped)).toBe(true);
    });
});
