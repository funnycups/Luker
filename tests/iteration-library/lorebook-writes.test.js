/**
 * Unit tests for iteration-library/tools/lorebook-writes.js — the shared
 * module that exposes lorebook *write* tools to iter popups.
 *
 * The module is plugin-agnostic: it owns the proposal computation
 * (`runLorebookWriteTool` — returns {before, after, kind} without touching
 * disk) and the apply-time commit (`applyLorebookProposal` — re-derives
 * from args against the entry's CURRENT on-disk state and writes once).
 * Both paths only need a SillyTavern-shaped context (loadWorldInfo +
 * saveWorldInfo); no cross-plugin dispatcher.
 */

import { describe, test, expect, jest } from '@jest/globals';
import {
    LOREBOOK_WRITE_TOOL_DEFS,
    LOREBOOK_WRITE_TOOL_NAMES,
    isLorebookWriteTool,
    runLorebookWriteTool,
    applyLorebookProposal,
    applyLorebookCommit,
} from '../../public/scripts/iteration-library/tools/lorebook-writes.js';

function makeBook(entries) {
    return { entries: structuredClone(entries) };
}

function makeContext(books) {
    const state = structuredClone(books);
    return {
        loadWorldInfo: jest.fn(async (name) => state[name] ?? null),
        saveWorldInfo: jest.fn(async (name, data) => { state[name] = data; }),
        _state: state,
    };
}

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
        expect(def.function.parameters.properties.patch.type).toBe('object');
        expect(def.function.parameters.properties.patch.additionalProperties).toBe(true);
    });

    test('lorebook_str_replace_in_entry requires book_name, uid, oldString, newString', () => {
        const def = LOREBOOK_WRITE_TOOL_DEFS.find(d => d.function.name === 'lorebook_str_replace_in_entry');
        expect([...def.function.parameters.required].sort()).toEqual(['book_name', 'newString', 'oldString', 'uid']);
    });

    test('LOREBOOK_WRITE_TOOL_NAMES is frozen and matches the defs', () => {
        expect(Object.isFrozen(LOREBOOK_WRITE_TOOL_NAMES)).toBe(true);
        expect([...LOREBOOK_WRITE_TOOL_NAMES].sort()).toEqual([
            'lorebook_str_replace_in_entry',
            'lorebook_update_entry',
        ]);
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

describe('runLorebookWriteTool — proposal mode (no disk writes)', () => {
    test('lorebook_update_entry returns {before, after, kind:update}', async () => {
        const ctx = makeContext({
            'Book A': makeBook({ 5: { uid: 5, content: 'old', disable: false, comment: 'C' } }),
        });
        const out = await runLorebookWriteTool(
            { id: 't1', name: 'lorebook_update_entry', args: { book_name: 'Book A', uid: 5, patch: { disable: true } } },
            { context: ctx },
        );
        expect(out.ok).toBe(true);
        expect(out.result.kind).toBe('update');
        expect(out.result.before.disable).toBe(false);
        expect(out.result.after.disable).toBe(true);
        // proposal mode never writes
        expect(ctx.saveWorldInfo).not.toHaveBeenCalled();
    });

    test('lorebook_str_replace_in_entry returns {before, after, kind:str_replace}', async () => {
        const ctx = makeContext({
            'B': makeBook({ 7: { uid: 7, content: 'hello world' } }),
        });
        const out = await runLorebookWriteTool(
            { id: 't2', name: 'lorebook_str_replace_in_entry', args: { book_name: 'B', uid: 7, oldString: 'hello', newString: 'hi' } },
            { context: ctx },
        );
        expect(out.ok).toBe(true);
        expect(out.result.kind).toBe('str_replace');
        expect(out.result.after.content).toBe('hi world');
        expect(ctx.saveWorldInfo).not.toHaveBeenCalled();
    });

    test('rejects non-write tool names without touching context', async () => {
        const ctx = makeContext({});
        const out = await runLorebookWriteTool(
            { name: 'lorebook_get', args: {} },
            { context: ctx },
        );
        expect(out.ok).toBe(false);
        expect(out.error).toMatch(/Not a lorebook write tool/);
        expect(ctx.loadWorldInfo).not.toHaveBeenCalled();
    });

    test('returns an error when context is missing', async () => {
        const out = await runLorebookWriteTool({ name: 'lorebook_update_entry', args: {} });
        expect(out.ok).toBe(false);
        expect(out.error).toMatch(/context is required/);
    });

    test('captures throw paths as { ok: false, error }', async () => {
        const ctx = makeContext({});
        const out = await runLorebookWriteTool(
            { name: 'lorebook_update_entry', args: { book_name: 'Missing', uid: 0, patch: { x: 1 } } },
            { context: ctx },
        );
        expect(out.ok).toBe(false);
        expect(out.error).toMatch(/not found/);
    });

    test('normalizes args to {} when caller omits or passes a non-object', async () => {
        const ctx = makeContext({});
        const out = await runLorebookWriteTool({ name: 'lorebook_update_entry' }, { context: ctx });
        // book_name missing → throws inside computeUpdate → captured as error
        expect(out.ok).toBe(false);
        expect(out.error).toMatch(/book_name/);
    });
});

describe('applyLorebookProposal — apply-time commit re-derives from args', () => {
    test('update kind: writes once with the patch applied to current on-disk state', async () => {
        const ctx = makeContext({
            'B': makeBook({ 5: { uid: 5, content: 'live', disable: false } }),
        });
        const res = await applyLorebookProposal(ctx, {
            kind: 'update',
            args: { book_name: 'B', uid: 5, patch: { disable: true } },
        });
        expect(res).toEqual({ ok: true, book_name: 'B', uid: 5 });
        expect(ctx.saveWorldInfo).toHaveBeenCalledTimes(1);
        expect(ctx._state['B'].entries[5].disable).toBe(true);
    });

    test('str_replace kind: writes new content derived from current entry', async () => {
        const ctx = makeContext({
            'B': makeBook({ 7: { uid: 7, content: 'foo bar baz' } }),
        });
        const res = await applyLorebookProposal(ctx, {
            kind: 'str_replace',
            args: { book_name: 'B', uid: 7, oldString: 'bar', newString: 'qux' },
        });
        expect(res.ok).toBe(true);
        expect(ctx._state['B'].entries[7].content).toBe('foo qux baz');
    });

    test('rejects unknown kind', async () => {
        const ctx = makeContext({});
        await expect(applyLorebookProposal(ctx, { kind: 'wat', args: {} })).rejects.toThrow(/unknown kind/);
    });
});

describe('applyLorebookCommit — direct commit with a pre-computed after', () => {
    test('merges after over the live entry, preserving uid as the address', async () => {
        const ctx = makeContext({
            'B': makeBook({ 5: { uid: 5, content: 'old', _bookkeeping: 'keep-me' } }),
        });
        await applyLorebookCommit(ctx, { book_name: 'B', uid: 5, after: { content: 'new', uid: 999 } });
        expect(ctx._state['B'].entries[5].content).toBe('new');
        // uid is the address — apply must NOT honor a uid in after.
        expect(ctx._state['B'].entries[5].uid).toBe(5);
        // unrelated bookkeeping fields are preserved (Object.assign merge).
        expect(ctx._state['B'].entries[5]._bookkeeping).toBe('keep-me');
    });

    test('throws on missing book / uid', async () => {
        const ctx = makeContext({});
        await expect(applyLorebookCommit(ctx, { book_name: '', uid: 0, after: {} })).rejects.toThrow(/book_name/);
    });
});
