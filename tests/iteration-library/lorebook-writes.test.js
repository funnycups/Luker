/**
 * Unit tests for iteration-library/tools/lorebook-writes.js — the shared
 * module that exposes lorebook *write* tools to iter popups.
 *
 * Mirrors tests/iteration-library/runner.test.js in style: real module
 * imports (no jest.unstable_mockModule needed) since the writes module is
 * plugin-agnostic and only translates names + forwards to an injected
 * dispatch function.
 */

import { describe, test, expect, jest } from '@jest/globals';
import {
    LOREBOOK_WRITE_TOOL_DEFS,
    LOREBOOK_WRITE_TOOL_LEGACY_NAMES,
    isLorebookWriteTool,
    runLorebookWriteTool,
} from '../../public/scripts/iteration-library/tools/lorebook-writes.js';

describe('LOREBOOK_WRITE_TOOL_DEFS — public surface', () => {
    test('exposes exactly the two write tools by short name', () => {
        const names = LOREBOOK_WRITE_TOOL_DEFS.map(d => d?.function?.name).sort();
        expect(names).toEqual(['lorebook_str_replace_in_entry', 'lorebook_update_entry']);
    });

    test('every def is a function-type OpenAI schema with required params', () => {
        for (const def of LOREBOOK_WRITE_TOOL_DEFS) {
            expect(def.type).toBe('function');
            expect(typeof def.function.name).toBe('string');
            expect(typeof def.function.description).toBe('string');
            expect(def.function.parameters.type).toBe('object');
            expect(Array.isArray(def.function.parameters.required)).toBe(true);
            expect(def.function.parameters.additionalProperties).toBe(false);
        }
    });

    test('lorebook_update_entry requires book_name, uid, patch', () => {
        const def = LOREBOOK_WRITE_TOOL_DEFS.find(d => d.function.name === 'lorebook_update_entry');
        expect([...def.function.parameters.required].sort()).toEqual(['book_name', 'patch', 'uid']);
        // patch is an open object so the model can pass any subset of entry
        // fields (content, disable, key, comment, …).
        expect(def.function.parameters.properties.patch.type).toBe('object');
        expect(def.function.parameters.properties.patch.additionalProperties).toBe(true);
    });

    test('lorebook_str_replace_in_entry requires book_name, uid, oldString, newString', () => {
        const def = LOREBOOK_WRITE_TOOL_DEFS.find(d => d.function.name === 'lorebook_str_replace_in_entry');
        expect([...def.function.parameters.required].sort()).toEqual(['book_name', 'newString', 'oldString', 'uid']);
    });
});

describe('LOREBOOK_WRITE_TOOL_LEGACY_NAMES — short → legacy wire names', () => {
    test('maps lorebook_update_entry → luker_card_update_lorebook_entry', () => {
        expect(LOREBOOK_WRITE_TOOL_LEGACY_NAMES.lorebook_update_entry).toBe('luker_card_update_lorebook_entry');
    });

    test('maps lorebook_str_replace_in_entry → luker_card_str_replace_in_lorebook_entry', () => {
        expect(LOREBOOK_WRITE_TOOL_LEGACY_NAMES.lorebook_str_replace_in_entry).toBe('luker_card_str_replace_in_lorebook_entry');
    });

    test('is frozen so callers cannot mutate the mapping at runtime', () => {
        expect(Object.isFrozen(LOREBOOK_WRITE_TOOL_LEGACY_NAMES)).toBe(true);
    });
});

describe('isLorebookWriteTool — predicate', () => {
    test.each([
        ['lorebook_update_entry', true],
        ['lorebook_str_replace_in_entry', true],
        ['lorebook_get', false],
        ['lorebook_query', false],
        ['world_book_list', false],
        ['', false],
        [null, false],
        [undefined, false],
        [42, false],
    ])('%p → %p', (name, expected) => {
        expect(isLorebookWriteTool(name)).toBe(expected);
    });
});

describe('runLorebookWriteTool — dispatch behaviour', () => {
    test('routes lorebook_update_entry to its legacy wire name with args preserved', async () => {
        const dispatch = jest.fn().mockResolvedValue({ ok: true });
        await runLorebookWriteTool(
            {
                id: 't1',
                name: 'lorebook_update_entry',
                args: { book_name: 'Book A', uid: 5, patch: { disable: true } },
            },
            { dispatch, helperApis: [{ tag: 'apiSentinel' }] },
        );
        expect(dispatch).toHaveBeenCalledTimes(1);
        const [legacyCall, helperApis] = dispatch.mock.calls[0];
        expect(legacyCall.name).toBe('luker_card_update_lorebook_entry');
        expect(legacyCall.id).toBe('t1');
        expect(legacyCall.args).toEqual({ book_name: 'Book A', uid: 5, patch: { disable: true } });
        expect(helperApis).toEqual([{ tag: 'apiSentinel' }]);
    });

    test('routes lorebook_str_replace_in_entry to its legacy wire name', async () => {
        const dispatch = jest.fn().mockResolvedValue('done');
        await runLorebookWriteTool(
            {
                id: 't2',
                name: 'lorebook_str_replace_in_entry',
                args: { book_name: 'B', uid: 7, oldString: 'foo', newString: 'bar' },
            },
            { dispatch },
        );
        expect(dispatch.mock.calls[0][0].name).toBe('luker_card_str_replace_in_lorebook_entry');
    });

    test('unwraps { result } envelope when the dispatcher returns one', async () => {
        const dispatch = jest.fn().mockResolvedValue({ result: { ok: true, uid: 5 } });
        const out = await runLorebookWriteTool(
            { id: 'x', name: 'lorebook_update_entry', args: { book_name: 'B', uid: 5, patch: { disable: true } } },
            { dispatch },
        );
        expect(out).toEqual({ ok: true, result: { ok: true, uid: 5 } });
    });

    test('passes raw value through when dispatcher returns a plain payload (no `result` key)', async () => {
        const dispatch = jest.fn().mockResolvedValue({ ok: true, uid: 5 });
        const out = await runLorebookWriteTool(
            { id: 'x', name: 'lorebook_update_entry', args: { book_name: 'B', uid: 5, patch: { disable: true } } },
            { dispatch },
        );
        expect(out.ok).toBe(true);
        expect(out.result).toEqual({ ok: true, uid: 5 });
    });

    test('captures dispatcher errors as { ok: false, error } rather than throwing', async () => {
        const dispatch = jest.fn().mockRejectedValue(new Error('boom'));
        const out = await runLorebookWriteTool(
            { id: 'x', name: 'lorebook_update_entry', args: { book_name: 'B', uid: 5, patch: { disable: true } } },
            { dispatch },
        );
        expect(out).toEqual({ ok: false, error: 'boom' });
    });

    test('rejects non-write tool names without invoking dispatch', async () => {
        const dispatch = jest.fn();
        const out = await runLorebookWriteTool(
            { name: 'lorebook_get', args: {} },
            { dispatch },
        );
        expect(out.ok).toBe(false);
        expect(out.error).toMatch(/Not a lorebook write tool/);
        expect(dispatch).not.toHaveBeenCalled();
    });

    test('returns an error when dispatch is missing', async () => {
        const out = await runLorebookWriteTool(
            { name: 'lorebook_update_entry', args: {} },
        );
        expect(out.ok).toBe(false);
        expect(out.error).toMatch(/dispatch must be a function/);
    });

    test('normalizes args to {} when the caller omits or passes a non-object', async () => {
        const dispatch = jest.fn().mockResolvedValue({});
        await runLorebookWriteTool(
            { name: 'lorebook_update_entry' },
            { dispatch },
        );
        expect(dispatch.mock.calls[0][0].args).toEqual({});

        dispatch.mockClear();
        await runLorebookWriteTool(
            { name: 'lorebook_update_entry', args: 'not-an-object' },
            { dispatch },
        );
        expect(dispatch.mock.calls[0][0].args).toEqual({});
    });
});
