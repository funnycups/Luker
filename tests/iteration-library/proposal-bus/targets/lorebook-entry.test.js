import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import { createBus } from '/scripts/iteration-library/proposal-bus/bus.js';
import { clearRegistry, hasTarget, resolveTarget } from '/scripts/iteration-library/storage/target-registry.js';
import {
    LOREBOOK_ENTRY_TARGET_TYPE,
    ensureLorebookEntryTarget,
} from '/scripts/iteration-library/proposal-bus/targets/lorebook-entry.js';
import { lorebookWrite } from '/scripts/iteration-library/proposal-bus/kinds/lorebook-write.js';
import { runLorebookWriteTool } from '/scripts/iteration-library/tools/lorebook-writes.js';
import { STATE_ERROR_REASONS } from '/scripts/lib/state-errors.js';
import { createWorldInfoHarness, worldInfoContext } from '../../real-worldinfo-context.js';
let harness;
beforeEach(async () => { harness = await createWorldInfoHarness(); });

const BOOK = 'Bryn Headland';
const LANTERN = {
    uid: 3,
    key: ['lantern'],
    comment: 'lantern',
    content: 'The headland lantern burns whale oil and is trimmed at the second bell.',
    disable: false,
};
const GULLS = {
    uid: 4,
    key: ['gull rocks'],
    comment: 'gull rocks',
    content: 'Three breakers north of the gull rocks mark the safe channel.',
    disable: false,
};

function makeContext() {
    const { disk: books, context } = worldInfoContext(harness, { [BOOK]: { entries: { 3: structuredClone(LANTERN), 4: structuredClone(GULLS) } } });
    return {
        ...context,
        loadWorldInfo: jest.spyOn(context, 'loadWorldInfo'),
        saveWorldInfo: jest.spyOn(context, 'saveWorldInfo'),
        books,
    };
}

function makeBus() {
    const bus = createBus();
    bus.registerKind('lorebook-write', lorebookWrite);
    return bus;
}

function entryTarget(uid, extra = {}) {
    return { type: LOREBOOK_ENTRY_TARGET_TYPE, name: BOOK, uid, ...extra };
}

async function proposeTool(bus, ctx, id, name, args) {
    const out = await runLorebookWriteTool({ id, name, args }, { context: ctx });
    expect(out.ok).toBe(true);
    return bus.propose({
        kind: 'lorebook-write',
        target: entryTarget(out.result.uid),
        before: out.result.before,
        after: out.result.after,
        sourceCallId: id,
    });
}

beforeEach(() => clearRegistry());

describe('lorebook entry target — registration', () => {
    test('type string stays the persisted orch-lorebook value', () => {
        expect(LOREBOOK_ENTRY_TARGET_TYPE).toBe('orch-lorebook');
        expect(lorebookWrite.targetType).toBe(LOREBOOK_ENTRY_TARGET_TYPE);
    });

    test('ensureLorebookEntryTarget registers once', () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            expect(hasTarget(LOREBOOK_ENTRY_TARGET_TYPE)).toBe(false);
            ensureLorebookEntryTarget(makeContext());
            const first = resolveTarget({ type: LOREBOOK_ENTRY_TARGET_TYPE });
            ensureLorebookEntryTarget(makeContext());
            expect(resolveTarget({ type: LOREBOOK_ENTRY_TARGET_TYPE })).toBe(first);
            expect(warn).not.toHaveBeenCalled();
        } finally {
            warn.mockRestore();
        }
    });

    test('a later ensure call rebinds the context the handler reads through', async () => {
        const first = makeContext();
        const second = makeContext();
        second.books[BOOK] = { ...second.books[BOOK], entries: { ...second.books[BOOK].entries, 3: { ...second.books[BOOK].entries[3], content: 'The keeper swapped the lantern for a storm lamp.' } } };
        ensureLorebookEntryTarget(first);
        ensureLorebookEntryTarget(second);
        const entry = await resolveTarget(entryTarget(3)).read(entryTarget(3));
        expect(entry.content).toBe('The keeper swapped the lantern for a storm lamp.');
        expect(first.loadWorldInfo).not.toHaveBeenCalled();
    });
});

describe('lorebook entry target — read / write', () => {
    test('read returns a clone of the addressed entry and throws CONFLICT when absent', async () => {
        const ctx = makeContext();
        ensureLorebookEntryTarget(ctx);
        const handler = resolveTarget(entryTarget(3));
        const entry = await handler.read(entryTarget(3));
        expect(entry).toEqual(LANTERN);
        entry.content = 'mutated by the caller';
        expect(ctx.books[BOOK].entries[3].content).toBe(LANTERN.content);
        await expect(handler.read(entryTarget(99)))
            .rejects.toMatchObject({ name: 'LorebookError', reason: STATE_ERROR_REASONS.CONFLICT });
        await expect(handler.read({ type: LOREBOOK_ENTRY_TARGET_TYPE, name: 'Missing Book', uid: 3 }))
            .rejects.toMatchObject({ name: 'LorebookError', reason: STATE_ERROR_REASONS.CONFLICT });
    });

    test('write clones the loaded book before saving so failed writes never mutate cached book state', async () => {
        const ctx = makeContext();
        const originalBook = ctx.books[BOOK];
        ctx.loadWorldInfo = jest.fn(async () => originalBook);
        ctx.saveWorldInfo = jest.fn(async () => { throw new Error('disk full'); });
        ensureLorebookEntryTarget(ctx);
        await expect(resolveTarget(entryTarget(3)).write(entryTarget(3), { uid: 3, content: 'Should not stick' }))
            .rejects.toThrow('disk full');
        expect(originalBook.entries[3].content).toBe(LANTERN.content);
    });

    test('write replaces the entry, pins the uid, and saves with refreshEditor', async () => {
        const ctx = makeContext();
        ensureLorebookEntryTarget(ctx);
        await resolveTarget(entryTarget(3)).write(entryTarget(3), { uid: 77, key: ['lantern'], content: 'Rewritten.' });
        expect(ctx.saveWorldInfo).toHaveBeenCalledTimes(1);
        const [name, data, immediately, opts] = ctx.saveWorldInfo.mock.calls[0];
        expect(name).toBe(BOOK);
        expect(immediately).toBe(true);
        expect(opts).toEqual({ refreshEditor: true });
        expect(data.entries[3]).toEqual({ uid: 3, key: ['lantern'], content: 'Rewritten.' });
        expect(data.entries[4]).toEqual(GULLS);
    });

    test('write on a missing entry or book throws CONFLICT without saving', async () => {
        const ctx = makeContext();
        ensureLorebookEntryTarget(ctx);
        const handler = resolveTarget(entryTarget(3));
        await expect(handler.write(entryTarget(99), { content: 'x' }))
            .rejects.toMatchObject({ name: 'LorebookError', reason: STATE_ERROR_REASONS.CONFLICT });
        await expect(handler.write({ type: LOREBOOK_ENTRY_TARGET_TYPE, name: 'Missing Book', uid: 3 }, { content: 'x' }))
            .rejects.toMatchObject({ name: 'LorebookError', reason: STATE_ERROR_REASONS.CONFLICT });
        expect(ctx.saveWorldInfo).not.toHaveBeenCalled();
    });

    test('an address without a book name or non-negative integer uid is VALIDATION_ARGS', async () => {
        const ctx = makeContext();
        ensureLorebookEntryTarget(ctx);
        const handler = resolveTarget(entryTarget(3));
        await expect(handler.read({ type: LOREBOOK_ENTRY_TARGET_TYPE, name: BOOK, uid: -1 }))
            .rejects.toMatchObject({ reason: STATE_ERROR_REASONS.VALIDATION_ARGS });
        await expect(handler.write({ type: LOREBOOK_ENTRY_TARGET_TYPE, name: '', uid: 3 }, {}))
            .rejects.toMatchObject({ reason: STATE_ERROR_REASONS.VALIDATION_ARGS });
    });

    test('describe names the book', () => {
        ensureLorebookEntryTarget(makeContext());
        expect(resolveTarget(entryTarget(3)).describe(entryTarget(3))).toBe(`lorebook:${BOOK}`);
    });
});

describe('lorebook entry target — through the real bus', () => {
    test('approve commits an update proposal to disk', async () => {
        const ctx = makeContext();
        ensureLorebookEntryTarget(ctx);
        const bus = makeBus();
        const { id } = await proposeTool(bus, ctx, 'c1', 'lorebook_update_entry', { book_name: BOOK, uid: 3, patch: { disable: true } });
        expect(ctx.saveWorldInfo).not.toHaveBeenCalled();
        expect(await bus.approve(id)).toEqual({ ok: true, status: 'committed' });
        expect(ctx.books[BOOK].entries[3]).toEqual({ ...LANTERN, disable: true });
    });

    test('proposals on disjoint fields of one entry both commit', async () => {
        const ctx = makeContext();
        ensureLorebookEntryTarget(ctx);
        const bus = makeBus();
        const a = await proposeTool(bus, ctx, 'c1', 'lorebook_update_entry', { book_name: BOOK, uid: 3, patch: { disable: true } });
        const b = await proposeTool(bus, ctx, 'c2', 'lorebook_str_replace_in_entry', {
            book_name: BOOK, uid: 3, oldString: 'second bell', newString: 'turn of the ebb',
        });
        expect((await bus.approve(a.id)).status).toBe('committed');
        expect((await bus.approve(b.id)).status).toBe('committed');
        expect(ctx.books[BOOK].entries[3]).toEqual({
            ...LANTERN,
            disable: true,
            content: LANTERN.content.replace('second bell', 'turn of the ebb'),
        });
    });

    test('approve parks a conflict when a patched field drifted, without saving', async () => {
        const ctx = makeContext();
        ensureLorebookEntryTarget(ctx);
        const bus = makeBus();
        const { id } = await proposeTool(bus, ctx, 'c1', 'lorebook_str_replace_in_entry', {
            book_name: BOOK, uid: 3, oldString: 'second bell', newString: 'turn of the ebb',
        });
        ctx.books[BOOK] = { ...ctx.books[BOOK], entries: { ...ctx.books[BOOK].entries, 3: { ...ctx.books[BOOK].entries[3], content: 'The keeper swapped the lantern for a storm lamp.' } } };
        const out = await bus.approve(id);
        expect(out).toMatchObject({ ok: false, status: 'conflict', reason: STATE_ERROR_REASONS.CONFLICT });
        expect(ctx.saveWorldInfo).not.toHaveBeenCalled();
        expect(ctx.books[BOOK].entries[3].content).toBe('The keeper swapped the lantern for a storm lamp.');
    });

    test('approve parks a conflict when the entry was deleted', async () => {
        const ctx = makeContext();
        ensureLorebookEntryTarget(ctx);
        const bus = makeBus();
        const { id } = await proposeTool(bus, ctx, 'c1', 'lorebook_update_entry', { book_name: BOOK, uid: 3, patch: { comment: 'lantern log' } });
        const book = ctx.books[BOOK];
        delete book.entries[3];
        ctx.books[BOOK] = book;
        expect(await bus.approve(id)).toMatchObject({ ok: false, status: 'conflict' });
        expect(ctx.saveWorldInfo).not.toHaveBeenCalled();
    });

    test('rollback restores content and removes a key the proposal added', async () => {
        const ctx = makeContext();
        ensureLorebookEntryTarget(ctx);
        const bus = makeBus();
        const { id } = await proposeTool(bus, ctx, 'c1', 'lorebook_update_entry', {
            book_name: BOOK, uid: 3, patch: { content: 'The lantern now burns seal oil.', probability: 40 },
        });
        await bus.approve(id);
        expect(ctx.books[BOOK].entries[3].probability).toBe(40);
        expect(await bus.rollback(id)).toEqual({ ok: true, status: 'rolledBack' });
        expect(ctx.books[BOOK].entries[3]).toEqual(LANTERN);
        expect(Object.prototype.hasOwnProperty.call(ctx.books[BOOK].entries[3], 'probability')).toBe(false);
    });

    test('write ignores a legacy target._op', async () => {
        const ctx = makeContext();
        ensureLorebookEntryTarget(ctx);
        const bus = makeBus();
        const after = { ...structuredClone(LANTERN), comment: 'lantern — second bell' };
        const { id } = await bus.propose({
            kind: 'lorebook-write',
            target: entryTarget(3, {
                _op: { kind: 'update', args: { book_name: BOOK, uid: 3, patch: { content: 'Replayed from a stale op.' } } },
            }),
            before: structuredClone(LANTERN),
            after,
            sourceCallId: 'c1',
        });
        await bus.approve(id);
        expect(ctx.books[BOOK].entries[3]).toEqual(after);
    });
});
