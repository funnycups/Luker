/**
 * Unit tests for iteration-library/tools/lorebook-writes.js — the shared
 * module that exposes lorebook *write* tools to iter popups.
 *
 * The module is plugin-agnostic: it owns the proposal computation
 * (`runLorebookWriteTool` — returns {before, after, kind} without touching
 * disk). Approval chains run through the real ProposalBus and the shared
 * lorebook entry target. Everything only needs a SillyTavern-shaped
 * context (loadWorldInfo + saveWorldInfo); no cross-plugin dispatcher.
 */

import { describe, test, expect, jest } from '@jest/globals';
import {
    LOREBOOK_WRITE_TOOL_DEFS,
    LOREBOOK_WRITE_TOOL_NAMES,
    isLorebookWriteTool,
    runLorebookWriteTool,
} from '../../public/scripts/iteration-library/tools/lorebook-writes.js';
import { createBus } from '../../public/scripts/iteration-library/proposal-bus/bus.js';
import { clearRegistry } from '../../public/scripts/iteration-library/storage/target-registry.js';
import {
    LOREBOOK_ENTRY_TARGET_TYPE,
    ensureLorebookEntryTarget,
} from '../../public/scripts/iteration-library/proposal-bus/targets/lorebook-entry.js';
import { lorebookWrite } from '../../public/scripts/iteration-library/proposal-bus/kinds/lorebook-write.js';
import { createWorldInfoHarness, worldInfoContext } from './real-worldinfo-context.js';
let harness;
beforeEach(async () => { harness = await createWorldInfoHarness(); });

function makeBook(entries) {
    return { entries: structuredClone(entries) };
}

function makeContext(books) {
    const { disk: state, context } = worldInfoContext(harness, books);
    return {
        ...context,
        loadWorldInfo: jest.spyOn(context, 'loadWorldInfo'),
        saveWorldInfo: jest.spyOn(context, 'saveWorldInfo'),
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

describe('runLorebookWriteTool — cases ported from the CEA approval-flow suite', () => {
    test('rejects an empty patch object', async () => {
        const ctx = makeContext({ BookA: makeBook({ 5: { uid: 5 } }) });
        const out = await runLorebookWriteTool(
            { name: 'lorebook_update_entry', args: { book_name: 'BookA', uid: 5, patch: {} } },
            { context: ctx },
        );
        expect(out.ok).toBe(false);
        expect(out.error).toMatch(/patch must contain at least one field/);
    });

    test('after keeps the addressed uid when the patch tries to overwrite it', async () => {
        const ctx = makeContext({ BookA: makeBook({ 5: { uid: 5, content: 'x' } }) });
        const out = await runLorebookWriteTool(
            { name: 'lorebook_update_entry', args: { book_name: 'BookA', uid: 5, patch: { uid: 999, content: 'y' } } },
            { context: ctx },
        );
        expect(out.ok).toBe(true);
        expect(out.result.after.uid).toBe(5);
        expect(out.result.updated_fields).toEqual(['content']);
    });

    test('rejects a multi-site oldString without replaceAll', async () => {
        const ctx = makeContext({ BookA: makeBook({ 5: { uid: 5, content: 'must must must' } }) });
        const out = await runLorebookWriteTool(
            { name: 'lorebook_str_replace_in_entry', args: { book_name: 'BookA', uid: 5, oldString: 'must', newString: 'might' } },
            { context: ctx },
        );
        expect(out.ok).toBe(false);
        expect(out.error).toMatch(/more than once/);
    });

    test('accepts an empty newString to delete a clause', async () => {
        const ctx = makeContext({ BookA: makeBook({ 5: { uid: 5, content: 'keep [DROP THIS] tail' } }) });
        const out = await runLorebookWriteTool(
            { name: 'lorebook_str_replace_in_entry', args: { book_name: 'BookA', uid: 5, oldString: ' [DROP THIS]', newString: '' } },
            { context: ctx },
        );
        expect(out.ok).toBe(true);
        expect(out.result.after.content).toBe('keep tail');
    });
});

describe('approval chains through the shared entry target — ported from the CEA approval-flow suite', () => {
    function busFor(ctx) {
        clearRegistry();
        ensureLorebookEntryTarget(ctx);
        const bus = createBus();
        bus.registerKind('lorebook-write', lorebookWrite);
        return bus;
    }

    async function propose(bus, ctx, id, name, args) {
        const out = await runLorebookWriteTool({ id, name, args }, { context: ctx });
        expect(out.ok).toBe(true);
        return bus.propose({
            kind: 'lorebook-write',
            target: { type: LOREBOOK_ENTRY_TARGET_TYPE, name: out.result.book_name, uid: out.result.uid },
            before: out.result.before,
            after: out.result.after,
            sourceCallId: id,
        });
    }

    test('two update proposals on disjoint fields of one uid both land', async () => {
        const ctx = makeContext({ BookA: makeBook({ 5: { uid: 5, content: 'a', disable: false, comment: 'fmt' } }) });
        const bus = busFor(ctx);
        const a = await propose(bus, ctx, 'c1', 'lorebook_update_entry', { book_name: 'BookA', uid: 5, patch: { disable: true } });
        const b = await propose(bus, ctx, 'c2', 'lorebook_update_entry', { book_name: 'BookA', uid: 5, patch: { comment: 'new comment' } });
        expect((await bus.approve(a.id)).status).toBe('committed');
        expect((await bus.approve(b.id)).status).toBe('committed');
        expect(ctx._state.BookA.entries[5]).toEqual({ uid: 5, content: 'a', disable: true, comment: 'new comment' });
    });

    test('a str_replace proposed after an approved update matches the updated content', async () => {
        const ctx = makeContext({ BookA: makeBook({ 5: { uid: 5, content: 'must use markdown always' } }) });
        const bus = busFor(ctx);
        const a = await propose(bus, ctx, 'c1', 'lorebook_update_entry', { book_name: 'BookA', uid: 5, patch: { content: 'must use markdown sometimes' } });
        expect((await bus.approve(a.id)).status).toBe('committed');
        const b = await propose(bus, ctx, 'c2', 'lorebook_str_replace_in_entry', {
            book_name: 'BookA', uid: 5, oldString: 'must use markdown', newString: 'prefers markdown',
        });
        expect((await bus.approve(b.id)).status).toBe('committed');
        expect(ctx._state.BookA.entries[5].content).toBe('prefers markdown sometimes');
    });

    test('a str_replace computed before an update to the same field parks as a conflict', async () => {
        const ctx = makeContext({ BookA: makeBook({ 5: { uid: 5, content: 'must use markdown always' } }) });
        const bus = busFor(ctx);
        const a = await propose(bus, ctx, 'c1', 'lorebook_update_entry', { book_name: 'BookA', uid: 5, patch: { content: 'must use markdown sometimes' } });
        const b = await propose(bus, ctx, 'c2', 'lorebook_str_replace_in_entry', {
            book_name: 'BookA', uid: 5, oldString: 'always', newString: 'often',
        });
        expect((await bus.approve(a.id)).status).toBe('committed');
        expect(await bus.approve(b.id)).toMatchObject({ ok: false, status: 'conflict' });
        expect(ctx._state.BookA.entries[5].content).toBe('must use markdown sometimes');
        expect(ctx.saveWorldInfo).toHaveBeenCalledTimes(1);
    });

    test('a str_replace whose oldString drifted away fails at proposal time without saving', async () => {
        const ctx = makeContext({ BookA: makeBook({ 5: { uid: 5, content: 'the world has shifted' } }) });
        const out = await runLorebookWriteTool(
            { name: 'lorebook_str_replace_in_entry', args: { book_name: 'BookA', uid: 5, oldString: 'must use markdown', newString: 'prefers markdown' } },
            { context: ctx },
        );
        expect(out.ok).toBe(false);
        expect(out.error).toMatch(/not found/);
        expect(ctx.saveWorldInfo).not.toHaveBeenCalled();
    });
});
