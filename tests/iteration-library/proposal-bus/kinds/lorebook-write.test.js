import { describe, test, expect, jest } from '@jest/globals';
import { createLorebookWriteHandler } from '../../../../public/scripts/iteration-library/proposal-bus/kinds/lorebook-write.js';

function fakeBook(entries) {
    return {
        entries: Object.fromEntries(entries.map((e) => [String(e.uid), e])),
    };
}

describe('lorebook-write KindHandler', () => {
    test('fingerprint over the snapshot is deterministic', async () => {
        const h = createLorebookWriteHandler({
            applyProposal: jest.fn(async () => {}),
            loadWorldInfo: jest.fn(),
        });
        const f1 = await h.fingerprint({ uid: 1, content: 'x', comment: 'y' });
        const f2 = await h.fingerprint({ comment: 'y', content: 'x', uid: 1 });
        expect(f1).toBe(f2);
    });

    test('readCurrent loads the book and picks the snapshot entry by uid', async () => {
        const book = fakeBook([{ uid: 5, content: 'live', comment: 'now' }]);
        const loadWorldInfo = jest.fn(async () => book);
        const h = createLorebookWriteHandler({
            applyProposal: jest.fn(async () => {}),
            loadWorldInfo,
        });
        const op = { kind: 'update', args: { book_name: 'B', uid: 5 } };
        const { snapshot, fingerprint } = await h.readCurrent(op);
        expect(loadWorldInfo).toHaveBeenCalledWith('B');
        expect(snapshot).toEqual({ uid: 5, content: 'live', comment: 'now' });
        expect(fingerprint).toBe(await h.fingerprint({ uid: 5, content: 'live', comment: 'now' }));
    });

    test('readCurrent returns null snapshot when entry vanished', async () => {
        const loadWorldInfo = jest.fn(async () => fakeBook([]));
        const h = createLorebookWriteHandler({
            applyProposal: jest.fn(async () => {}),
            loadWorldInfo,
        });
        const op = { kind: 'update', args: { book_name: 'B', uid: 99 } };
        const { snapshot, fingerprint } = await h.readCurrent(op);
        expect(snapshot).toBeNull();
        expect(fingerprint).toBe(await h.fingerprint(null));
    });

    test('commit forwards op to applyProposal with the popup ctx', async () => {
        const applyProposal = jest.fn(async () => ({ ok: true }));
        const h = createLorebookWriteHandler({
            applyProposal,
            loadWorldInfo: jest.fn(),
        });
        const ctx = { token: 'sentinel' };
        const op = { kind: 'update', args: { book_name: 'B', uid: 7, content: 'new' } };
        await h.commit(op, ctx);
        expect(applyProposal).toHaveBeenCalledWith(ctx, { kind: 'update', args: op.args });
    });

    test('inverse rebuilds an update op that restores snapshot fields', () => {
        const h = createLorebookWriteHandler({
            applyProposal: jest.fn(),
            loadWorldInfo: jest.fn(),
        });
        const snapshot = { uid: 5, content: 'before', comment: 'b' };
        const op = { kind: 'update', args: { book_name: 'B', uid: 5, content: 'after' } };
        const inv = h.inverse(op, snapshot);
        expect(inv).toEqual({
            kind: 'update',
            args: { book_name: 'B', uid: 5, content: 'before', comment: 'b' },
        });
    });

    test('inverse returns null when snapshot is null or undefined', () => {
        const h = createLorebookWriteHandler({
            applyProposal: jest.fn(),
            loadWorldInfo: jest.fn(),
        });
        expect(h.inverse({ kind: 'update', args: {} }, null)).toBeNull();
        expect(h.inverse({ kind: 'update', args: {} }, undefined)).toBeNull();
    });

    test('label / icon / target accessors return meaningful strings', () => {
        const h = createLorebookWriteHandler({
            applyProposal: jest.fn(),
            loadWorldInfo: jest.fn(),
        });
        const entry = { op: { kind: 'update', args: { book_name: 'Lore', uid: 5 } } };
        expect(typeof h.label(entry)).toBe('string');
        expect(typeof h.icon(entry)).toBe('string');
        expect(h.target(entry)).toContain('Lore');
        expect(h.target(entry)).toContain('5');
    });

    test('renderDiffCard delegates to injected renderer with snapshot+op', () => {
        const renderDiff = jest.fn(() => '<pre>lore diff</pre>');
        const h = createLorebookWriteHandler({
            applyProposal: jest.fn(),
            loadWorldInfo: jest.fn(),
            renderDiff,
        });
        const entry = {
            snapshot: { uid: 5, content: 'b' },
            op: { kind: 'update', args: { uid: 5, content: 'a' } },
        };
        const out = h.renderDiffCard(entry, { escapeHtml: (s) => s });
        expect(out).toBe('<pre>lore diff</pre>');
        expect(renderDiff).toHaveBeenCalledWith(entry.snapshot, entry.op, expect.any(Object));
    });

    test('inverseAvailable defaults to true', () => {
        const h = createLorebookWriteHandler({
            applyProposal: jest.fn(),
            loadWorldInfo: jest.fn(),
        });
        expect(h.inverseAvailable).toBe(true);
    });
});
