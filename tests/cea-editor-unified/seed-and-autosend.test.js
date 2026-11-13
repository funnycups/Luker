/**
 * @jest-environment jsdom
 */
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

// Verifies that seeding a draft into Workbench AI iteration populates the
// composer cleanly and omits empty drafts.

import { beforeAll, describe, expect, jest, test } from '@jest/globals';
import { createIteratePage } from '../../public/scripts/workbench/pages/iterate.js';
import { createCardTarget } from '../../public/scripts/workbench/targets/card.js';

beforeAll(() => {
    if (!globalThis.requestAnimationFrame) {
        globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
    }
    if (!globalThis.matchMedia) {
        globalThis.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });
    }
});

function makeApp(ctx) {
    const target = createCardTarget({ getContext: () => ctx });
    return {
        sessions: {
            list: jest.fn(async () => []),
            get: jest.fn(async () => null),
            create: jest.fn(async (fields) => ({ id: 's1', turns: [], ...fields })),
            update: jest.fn(async (_id, patch) => ({ id: 's1', turns: [], ...patch })),
            remove: jest.fn(async () => {}),
        },
        iterateTargets: () => [target],
        snapshot: () => ({
            card: { name: 'Alice', avatar: 'alice.png' },
            chat: { character: { name: 'Alice', avatar: 'alice.png' } },
        }),
        settings: () => ({}),
        toast: jest.fn(),
        refreshBadges: jest.fn(),
        source: { lastReply: async () => '', aiRequest: async () => ({ text: '', calls: [] }) },
    };
}

describe('CEA card Workbench seed draft behavior', () => {
    test('populates composer input when draft is provided on show()', async () => {
        const ctx = {
            characterId: 0,
            characters: [{ avatar: 'alice.png', name: 'Alice', data: { extensions: {} } }],
            loadWorldInfo: async () => null,
            getCharaAuxWorlds: () => [],
            chatWorldInfo: { getNames: () => [] },
        };
        const prevLuker = globalThis.Luker;
        globalThis.Luker = { getContext: () => ctx };
        try {
            const page = createIteratePage(makeApp(ctx));
            await page.show({ ws: 'card', scope: 'character', draft: 'Just imported this card.' });
            const textarea = page.el.querySelector('textarea.wb-input');
            expect(textarea?.value).toBe('Just imported this card.');
        } finally {
            globalThis.Luker = prevLuker;
        }
    });

    test('leaves composer empty when draft is omitted or whitespace-only', async () => {
        const ctx = {
            characterId: 0,
            characters: [{ avatar: 'alice.png', name: 'Alice', data: { extensions: {} } }],
            loadWorldInfo: async () => null,
            getCharaAuxWorlds: () => [],
            chatWorldInfo: { getNames: () => [] },
        };
        const prevLuker = globalThis.Luker;
        globalThis.Luker = { getContext: () => ctx };
        try {
            const page = createIteratePage(makeApp(ctx));
            await page.show({ ws: 'card', scope: 'character' });
            const textarea = page.el.querySelector('textarea.wb-input');
            expect(textarea?.value).toBe('');
        } finally {
            globalThis.Luker = prevLuker;
        }
    });
});
