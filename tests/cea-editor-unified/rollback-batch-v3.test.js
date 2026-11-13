// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Verifies CEA rollback across both edit shapes:
 *  - v3 RFC 6902 inverse patches decoded via `target-registry` + `decodeBackward`
 *  - v2 field-edit inverses via `inverseEdit` + `commitCardAndBooks` /
 *    `commitCharacterOperations` / `commitLorebookOperations`
 */

import { beforeEach, describe, expect, jest, test } from '@jest/globals';

jest.unstable_mockModule('../../public/scripts/popup.js', () => ({
    Popup: class { constructor() {} show() { return Promise.resolve('ok'); } },
    POPUP_TYPE: { DISPLAY: 'display' },
    POPUP_RESULT: { AFFIRMATIVE: 1, NEGATIVE: 2, CANCELLED: 0 },
}));

const { inverseEdit } = await import('../../public/scripts/lib/edits/index.js');
const { decodeBackward } = await import('../../public/scripts/iteration-library/storage/patch-codec.js');
const registry = await import('../../public/scripts/iteration-library/storage/target-registry.js');
const { commitCardAndBooks } = await import('../../public/scripts/workbench/model/commit.js');
const { cardEditsFor } = await import('../../public/scripts/workbench/model/adapters.js');

describe('CEA rollback — v2 and v3 edit shapes', () => {
    beforeEach(() => {
        registry.clearRegistry();
    });

    test('rolls back v3 character inverse patch via target-registry + decodeBackward', async () => {
        const characterReadSpy = jest.fn(async () => ({ description: 'AFTER' }));
        const characterWriteSpy = jest.fn(async () => {});
        registry.registerTarget('character', {
            read: characterReadSpy,
            write: characterWriteSpy,
            describe: () => 'character',
        });

        const v3Edit = {
            target: { type: 'character' },
            inverse: [{ op: 'replace', path: '/description', value: 'BEFORE' }],
        };
        const handler = registry.resolveTarget(v3Edit.target);
        const current = await handler.read(v3Edit.target);
        const rolledBack = decodeBackward(current, v3Edit.inverse);
        await handler.write(v3Edit.target, rolledBack);

        expect(characterReadSpy).toHaveBeenCalledTimes(1);
        expect(characterWriteSpy).toHaveBeenCalledWith({ type: 'character' }, { description: 'BEFORE' });
    });

    test('rolls back v3 lorebook inverse patch via registered lorebook handler', async () => {
        const lorebookReadSpy = jest.fn(async () => ({ entries: { 0: { content: 'AFTER' } } }));
        const lorebookWriteSpy = jest.fn(async () => {});
        registry.registerTarget('lorebook', {
            read: lorebookReadSpy,
            write: lorebookWriteSpy,
            describe: (t) => `lorebook:${t?.name || ''}`,
        });

        const v3Edit = {
            target: { type: 'lorebook', name: 'Aurora Lore' },
            inverse: [{ op: 'replace', path: '/entries/0/content', value: 'BEFORE' }],
        };
        const handler = registry.resolveTarget(v3Edit.target);
        const current = await handler.read(v3Edit.target);
        const rolledBack = decodeBackward(current, v3Edit.inverse);
        await handler.write(v3Edit.target, rolledBack);

        expect(lorebookReadSpy).toHaveBeenCalledTimes(1);
        expect(lorebookWriteSpy).toHaveBeenCalledWith(
            { type: 'lorebook', name: 'Aurora Lore' },
            { entries: { 0: { content: 'BEFORE' } } },
        );
    });

    test('rolls back v2 character and lorebook edits via inverseEdit + commitCardAndBooks undo', async () => {
        const v2Edit = { op: 'set', path: 'description', oldValue: 'BEFORE', newValue: 'AFTER' };
        expect(inverseEdit(v2Edit)).toEqual({
            op: 'set',
            path: 'description',
            oldValue: 'AFTER',
            newValue: 'BEFORE',
        });

        const storedBook = { entries: { 0: { uid: 0, content: 'before-v2' } } };
        let liveDescription = 'BEFORE_V2';
        const commitCardSpy = jest.fn(async (edits) => {
            for (const e of edits) {
                if (e.path === 'description') liveDescription = e.newValue;
            }
            return { persisted: true, conflicts: [], alreadyDone: [] };
        });

        const batch = cardEditsFor(
            { character: { description: 'BEFORE_V2' }, lorebooks: { BookA: { entries: { 0: { uid: 0, content: 'before-v2' } } } } },
            { character: { description: 'AFTER_V2' }, lorebooks: { BookA: { entries: { 0: { uid: 0, content: 'after-v2' } } } } },
            ['card:description', 'wi:BookA:0'],
        );
        const handle = await commitCardAndBooks(batch, {
            commitCard: commitCardSpy,
            readBook: async () => structuredClone(storedBook),
            saveBook: async (_name, data) => { storedBook.entries = structuredClone(data.entries); },
        });
        expect(liveDescription).toBe('AFTER_V2');
        expect(storedBook.entries[0].content).toBe('after-v2');

        await handle.undo();
        expect(liveDescription).toBe('BEFORE_V2');
        expect(storedBook.entries[0].content).toBe('before-v2');
    });
});
