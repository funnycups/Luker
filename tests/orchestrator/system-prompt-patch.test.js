import { describe, expect, test } from '@jest/globals';
import {
    applyStringPatch,
    SYSTEM_PROMPT_PATCH_SCHEMA_FIELDS,
} from '../../public/scripts/extensions/orchestrator/system-prompt-patch.js';

describe('applyStringPatch — Claude-Code-Edit-shaped find/replace primitive', () => {
    test('replaces a unique oldString with newString', () => {
        const r = applyStringPatch('the cat sat', { oldString: 'cat', newString: 'dog' });
        expect(r).toEqual({ ok: true, nextText: 'the dog sat' });
    });

    test('rejects with not_found when oldString does not appear', () => {
        const r = applyStringPatch('hello', { oldString: 'xyz', newString: 'y' });
        expect(r.ok).toBe(false);
        expect(r.error).toBe('not_found');
    });

    test('rejects with multiple_matches when oldString appears more than once and replaceAll is omitted', () => {
        const r = applyStringPatch('cat cat', { oldString: 'cat', newString: 'dog' });
        expect(r.ok).toBe(false);
        expect(r.error).toBe('multiple_matches');
    });

    test('replaceAll: true replaces every occurrence', () => {
        const r = applyStringPatch('cat cat cat', { oldString: 'cat', newString: 'dog', replaceAll: true });
        expect(r).toEqual({ ok: true, nextText: 'dog dog dog' });
    });

    test('replaceAll: true is still ok with a unique match', () => {
        const r = applyStringPatch('hello world', { oldString: 'world', newString: 'there', replaceAll: true });
        expect(r).toEqual({ ok: true, nextText: 'hello there' });
    });

    test('empty newString deletes the matched span', () => {
        const r = applyStringPatch('keep [DROP] tail', { oldString: ' [DROP]', newString: '' });
        expect(r).toEqual({ ok: true, nextText: 'keep tail' });
    });

    test('rejects with invalid_args when oldString is empty', () => {
        const r = applyStringPatch('hello', { oldString: '', newString: 'x' });
        expect(r.ok).toBe(false);
        expect(r.error).toBe('invalid_args');
    });

    test('rejects with invalid_args when oldString is missing', () => {
        const r = applyStringPatch('hello', { newString: 'x' });
        expect(r.ok).toBe(false);
        expect(r.error).toBe('invalid_args');
    });

    test('rejects with invalid_args when newString is not a string', () => {
        const r = applyStringPatch('hello', { oldString: 'h', newString: null });
        expect(r.ok).toBe(false);
        expect(r.error).toBe('invalid_args');
    });

    test('treats null currentText as empty string (and then misses)', () => {
        const r = applyStringPatch(null, { oldString: 'x', newString: 'y' });
        expect(r.ok).toBe(false);
        expect(r.error).toBe('not_found');
    });

    test('whitespace / case is strict — no normalization', () => {
        const r = applyStringPatch('Hello World', { oldString: 'hello world', newString: 'hi' });
        expect(r.ok).toBe(false);
        expect(r.error).toBe('not_found');
    });
});

describe('SYSTEM_PROMPT_PATCH_SCHEMA_FIELDS — JSON-schema fragment shared by all patch tools', () => {
    test('exposes oldString, newString, replaceAll with the expected types', () => {
        expect(SYSTEM_PROMPT_PATCH_SCHEMA_FIELDS.oldString.type).toBe('string');
        expect(SYSTEM_PROMPT_PATCH_SCHEMA_FIELDS.newString.type).toBe('string');
        expect(SYSTEM_PROMPT_PATCH_SCHEMA_FIELDS.replaceAll.type).toBe('boolean');
    });

    test('is frozen so callers cannot mutate the shared shape', () => {
        expect(Object.isFrozen(SYSTEM_PROMPT_PATCH_SCHEMA_FIELDS)).toBe(true);
    });
});
