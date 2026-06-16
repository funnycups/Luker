import { describe, test, expect, jest } from '@jest/globals';
import { createPresetCloneHandler } from '../../../../public/scripts/iteration-library/proposal-bus/kinds/preset-clone.js';

describe('preset-clone KindHandler', () => {
    test('fingerprint is deterministic over snapshot', async () => {
        const h = createPresetCloneHandler({
            cloneAndSwitchTarget: jest.fn(async () => ({ ok: true })),
            readSourceSnapshot: jest.fn(async () => ({ exists: true, hash: 'abc', target_taken: false })),
        });
        const a = await h.fingerprint({ exists: true, hash: 'abc', target_taken: false });
        const b = await h.fingerprint({ target_taken: false, hash: 'abc', exists: true });
        expect(a).toBe(b);
    });

    test('readCurrent forwards op to readSourceSnapshot and fingerprints', async () => {
        const readSourceSnapshot = jest.fn(async () => ({ exists: true, hash: 'h', target_taken: false }));
        const h = createPresetCloneHandler({
            cloneAndSwitchTarget: jest.fn(),
            readSourceSnapshot,
        });
        const op = { sourceName: 'A', newName: 'B' };
        const { snapshot, fingerprint } = await h.readCurrent(op);
        expect(readSourceSnapshot).toHaveBeenCalledWith(op);
        expect(snapshot).toEqual({ exists: true, hash: 'h', target_taken: false });
        expect(fingerprint).toBe(await h.fingerprint({ exists: true, hash: 'h', target_taken: false }));
    });

    test('commit calls cloneAndSwitchTarget with newName', async () => {
        const cloneAndSwitchTarget = jest.fn(async () => ({ ok: true }));
        const h = createPresetCloneHandler({
            cloneAndSwitchTarget,
            readSourceSnapshot: jest.fn(),
        });
        const op = { sourceName: 'A', newName: 'B' };
        await h.commit(op);
        expect(cloneAndSwitchTarget).toHaveBeenCalledWith('B');
    });

    test('commit throws when cloneAndSwitchTarget returns non-ok result', async () => {
        const cloneAndSwitchTarget = jest.fn(async () => ({ ok: false, error: 'name in use' }));
        const h = createPresetCloneHandler({
            cloneAndSwitchTarget,
            readSourceSnapshot: jest.fn(),
        });
        await expect(h.commit({ sourceName: 'A', newName: 'B' })).rejects.toThrow(/name in use/);
    });

    test('commit calls afterClone hook after a successful clone, with op result', async () => {
        const afterClone = jest.fn(async () => {});
        const cloneAndSwitchTarget = jest.fn(async () => ({ ok: true, ref: { name: 'B' } }));
        const h = createPresetCloneHandler({
            cloneAndSwitchTarget,
            readSourceSnapshot: jest.fn(),
            afterClone,
        });
        const op = { sourceName: 'A', newName: 'B' };
        await h.commit(op);
        expect(afterClone).toHaveBeenCalledWith(op, expect.objectContaining({ ok: true }));
    });

    test('inverse returns null (no automatic rollback)', () => {
        const h = createPresetCloneHandler({
            cloneAndSwitchTarget: jest.fn(),
            readSourceSnapshot: jest.fn(),
        });
        expect(h.inverse({ sourceName: 'A', newName: 'B' }, { exists: true })).toBeNull();
    });

    test('inverseAvailable is false', () => {
        const h = createPresetCloneHandler({
            cloneAndSwitchTarget: jest.fn(),
            readSourceSnapshot: jest.fn(),
        });
        expect(h.inverseAvailable).toBe(false);
    });

    test('label / icon / target produce strings and include sourceName + newName', () => {
        const h = createPresetCloneHandler({
            cloneAndSwitchTarget: jest.fn(),
            readSourceSnapshot: jest.fn(),
        });
        const entry = { op: { sourceName: 'src', newName: 'dst' } };
        expect(typeof h.label(entry)).toBe('string');
        expect(typeof h.icon(entry)).toBe('string');
        const tgt = h.target(entry);
        expect(tgt).toContain('src');
        expect(tgt).toContain('dst');
    });

    test('renderDiffCard delegates to injected renderer', () => {
        const renderDiff = jest.fn(() => '<p>clone</p>');
        const h = createPresetCloneHandler({
            cloneAndSwitchTarget: jest.fn(),
            readSourceSnapshot: jest.fn(),
            renderDiff,
        });
        const entry = { snapshot: { hash: 'h' }, op: { sourceName: 'A', newName: 'B' } };
        const out = h.renderDiffCard(entry, { escapeHtml: (s) => s });
        expect(out).toBe('<p>clone</p>');
        expect(renderDiff).toHaveBeenCalledWith(entry.snapshot, entry.op, expect.any(Object));
    });
});
