// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

// Verifies that loading the card target (`buildUnifiedCharacterEditorLiveSnapshot`
// and `createCardTarget().load`) always refreshes live state from disk / context
// rather than returning stale cached values when external edits occur.

import { describe, expect, jest, test, beforeAll, afterAll } from '@jest/globals';
import lodash from 'lodash';
import { installBrowserModuleContext } from '../util/browser-module-context.js';

jest.unstable_mockModule('../../public/scripts/popup.js', () => ({
    POPUP_TYPE: { DISPLAY: 'display' },
    POPUP_RESULT: { AFFIRMATIVE: 1, NEGATIVE: 2, CANCELLED: 0 },
    Popup: class { constructor() {} show() { return Promise.resolve(''); } },
}));

let browserEnv;
let createCardTarget;

beforeAll(async () => {
    browserEnv = installBrowserModuleContext({ lib: { lodash } });
    ({ createCardTarget } = await import('../../public/scripts/workbench/targets/card.js'));
});

afterAll(() => {
    browserEnv?.restore();
});

describe('CEA live snapshot refresh on load', () => {
    test('cardTarget.load picks up external edits', async () => {
        let bookContent = 'initial lore';
        const ctx = {
            characterId: 0,
            characters: [{
                avatar: 'alice.png',
                name: 'Alice',
                description: 'initial desc',
                data: { name: 'Alice', description: 'initial desc', extensions: { world: 'Lore' } },
            }],
            loadWorldInfo: async (name) => (name === 'Lore' ? { entries: { 1: { uid: 1, content: bookContent } } } : null),
            getCharaAuxWorlds: () => [],
            chatWorldInfo: { getNames: () => [] },
        };

        const card = createCardTarget({ getContext: () => ctx });
        const first = await card.load('character', ctx);
        expect(first.live.character.description).toBe('initial desc');
        expect(first.live.lorebooks.Lore.entries[1].content).toBe('initial lore');

        ctx.characters[0].description = 'fresh-from-disk';
        ctx.characters[0].data.description = 'fresh-from-disk';
        bookContent = 'updated lore on disk';

        const second = await card.load('character', ctx);
        expect(second.live.character.description).toBe('fresh-from-disk');
        expect(second.live.lorebooks.Lore.entries[1].content).toBe('updated lore on disk');
    });
});
