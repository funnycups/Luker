// tests/cea-character-iteration/session-store-schema.test.js
//
// Round-trips the new message schema fields (id / at / toolCalls / edits /
// appliedAt / appliedTarget / rolledBackAt / auto + top-level pendingEdits +
// surfaceState.isFinalized / finalizeSummary) through the CEA char-iter
// session store. Also covers makeMessageId and normalizeMessageShape
// directly so legacy message migration is verified.

import { describe, test, expect, beforeEach, jest } from '@jest/globals';

import {
    createCharacterIterationSessionStore,
    makeMessageId,
    normalizeMessageShape,
} from '../../public/scripts/extensions/character-editor-assistant/character-iteration/session-store.js';

describe('CEA char-iter session — new message schema persistence', () => {
    let settings;
    let store;

    beforeEach(() => {
        settings = {};
        store = createCharacterIterationSessionStore({
            getSettings: () => settings,
            persistSettings: jest.fn(),
            avatar: 'alice.png',
        });
    });

    test('save+load round-trips id/at/toolCalls/edits/appliedAt/appliedTarget/rolledBackAt/auto + pendingEdits + surfaceState.isFinalized', async () => {
        const session = {
            id: 'rt-1',
            title: 'Round trip',
            createdAt: 1,
            updatedAt: 1,
            surfaceState: {
                historyOpen: false,
                autoApply: true,
                isFinalized: true,
                finalizeSummary: 'Added a paragraph to backstory.',
            },
            messages: [
                { id: 'm1', role: 'user', content: 'Add backstory paragraph', at: 100 },
                {
                    id: 'm2', role: 'assistant', content: 'Done.', at: 200,
                    toolCalls: [{ name: 'cea_set_card_field', args: { field: 'description', value: 'new' } }],
                    edits: [{ op: 'set', path: 'card.description', oldValue: 'old', newValue: 'new' }],
                    appliedAt: 300,
                    appliedTarget: 'character',
                    rolledBackAt: null,
                },
                { id: 'm3', role: 'user', content: 'Add backstory paragraph', at: 400, auto: true },
            ],
            pendingEdits: [{ op: 'set', path: 'card.personality', oldValue: '', newValue: 'curious' }],
        };
        await store.save(session);
        const loaded = await store.load('rt-1');
        expect(loaded).not.toBeNull();
        expect(loaded.messages).toHaveLength(3);
        expect(loaded.messages[0]).toEqual(session.messages[0]);
        expect(loaded.messages[1].toolCalls).toEqual(session.messages[1].toolCalls);
        expect(loaded.messages[1].edits).toEqual(session.messages[1].edits);
        expect(loaded.messages[1].appliedAt).toBe(300);
        expect(loaded.messages[1].appliedTarget).toBe('character');
        expect(loaded.messages[1].rolledBackAt).toBeNull();
        // Synthetic auto-continue user message preserves auto flag.
        expect(loaded.messages[2].auto).toBe(true);
        // pendingEdits at the session top level survives.
        expect(loaded.pendingEdits).toEqual(session.pendingEdits);
        // surfaceState round-trips, including the new finalize fields.
        expect(loaded.surfaceState.isFinalized).toBe(true);
        expect(loaded.surfaceState.finalizeSummary).toBe('Added a paragraph to backstory.');
        expect(loaded.surfaceState.autoApply).toBe(true);
    });

    test('save+load preserves rolledBackAt timestamp (not null)', async () => {
        const session = {
            id: 'rb-1', title: '', createdAt: 1, updatedAt: 1, surfaceState: {},
            messages: [{
                id: 'm1', role: 'assistant', content: 'done', at: 100,
                toolCalls: [{ name: 'cea_set_card_field', args: { field: 'name', value: 'X' } }],
                edits: [{ op: 'set', path: 'card.name', oldValue: '', newValue: 'X' }],
                appliedAt: 200, appliedTarget: 'character', rolledBackAt: 500,
            }],
        };
        await store.save(session);
        const loaded = await store.load('rb-1');
        expect(loaded.messages[0].rolledBackAt).toBe(500);
        expect(loaded.messages[0].appliedTarget).toBe('character');
    });
});

describe('CEA char-iter — normalizeMessageShape (legacy message migration)', () => {
    test('regenerates id for legacy messages without one', () => {
        const legacy = { role: 'user', content: 'old' };
        const normalized = normalizeMessageShape(legacy, 5000);
        expect(normalized.id).toMatch(/^cea_charit_msg_/);
        expect(normalized.at).toBe(5000);
        expect(normalized.role).toBe('user');
        expect(normalized.content).toBe('old');
    });

    test('preserves an existing id', () => {
        const m = { id: 'existing_id', role: 'assistant', content: 'hi', at: 1234 };
        const n = normalizeMessageShape(m, 9000);
        expect(n.id).toBe('existing_id');
        expect(n.at).toBe(1234);
    });

    test('falls back to fallbackAt when at is missing', () => {
        const n = normalizeMessageShape({ role: 'user', content: 'x' }, 7777);
        expect(n.at).toBe(7777);
    });

    test('drops empty arrays (toolCalls/edits stay undefined)', () => {
        const n = normalizeMessageShape({ id: 'a', role: 'user', content: '', toolCalls: [], edits: [] }, 1);
        expect(n.toolCalls).toBeUndefined();
        expect(n.edits).toBeUndefined();
    });

    test('preserves toolCalls/edits/appliedAt/appliedTarget/auto when present', () => {
        const n = normalizeMessageShape({
            id: 'a', role: 'assistant', content: 'ok', at: 100,
            toolCalls: [{ name: 'cea_set_card_field' }],
            edits: [{ op: 'set', path: 'card.name', oldValue: '', newValue: 'X' }],
            appliedAt: 200, appliedTarget: 'character',
            rolledBackAt: 300,
            auto: true,
        }, 1);
        expect(n.toolCalls).toEqual([{ name: 'cea_set_card_field' }]);
        expect(n.edits).toEqual([{ op: 'set', path: 'card.name', oldValue: '', newValue: 'X' }]);
        expect(n.appliedAt).toBe(200);
        expect(n.appliedTarget).toBe('character');
        expect(n.rolledBackAt).toBe(300);
        expect(n.auto).toBe(true);
    });

    test('returns input unchanged for non-object', () => {
        expect(normalizeMessageShape(null)).toBeNull();
        expect(normalizeMessageShape(undefined)).toBeUndefined();
    });
});

describe('CEA char-iter — makeMessageId', () => {
    test('produces unique cea_charit_msg_-prefixed ids', () => {
        const a = makeMessageId();
        const b = makeMessageId();
        expect(a).toMatch(/^cea_charit_msg_/);
        expect(b).toMatch(/^cea_charit_msg_/);
        expect(a).not.toBe(b);
    });
});
