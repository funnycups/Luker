// tests/orchestrator/iter-studio-session-store.test.js
//
// Round-trips the new message schema fields (id / at / toolCalls / edits /
// appliedAt / appliedTarget / rolledBackAt / auto + top-level pendingEdits +
// surfaceState.isFinalized / finalizeSummary) through the orchestrator's
// iter-studio session store. Also covers makeMessageId and
// normalizeMessageShape directly so legacy message migration is verified
// without spinning up the popup's browser deps.

import { describe, test, expect, beforeEach } from '@jest/globals';

import {
    createOrchestratorIterationSessionStore,
    makeMessageId,
    normalizeMessageShape,
} from '../../public/scripts/extensions/orchestrator/iter-studio/session-store.js';

describe('Orchestrator iter-studio — session store basic round-trip', () => {
    let settingsRoot;
    let store;

    beforeEach(() => {
        settingsRoot = {};
        store = createOrchestratorIterationSessionStore({
            mode: 'spec',
            getOrchestratorSettingsRoot: () => settingsRoot,
            persistSettings: () => { /* no-op for tests */ },
            computeScope: () => 'global',
        });
    });

    test('save then list returns metadata sorted by updatedAt desc', async () => {
        await store.save({ id: 'a', title: 'one', messages: [], updatedAt: 100 });
        await store.save({ id: 'b', title: 'two', messages: [], updatedAt: 200 });
        const list = await store.list();
        expect(list.map(s => s.id)).toEqual(['b', 'a']);
    });

    test('load returns null for unknown id', async () => {
        expect(await store.load('missing')).toBeNull();
    });

    test('load returns a clone (mutating result does not affect storage)', async () => {
        await store.save({ id: 'a', title: 'one', messages: [{ role: 'user', content: 'hi' }], updatedAt: 1 });
        const loaded = await store.load('a');
        loaded.title = 'mutated';
        const reloaded = await store.load('a');
        expect(reloaded.title).toBe('one');
    });

    test('delete removes the entry', async () => {
        await store.save({ id: 'a', title: 'one', messages: [], updatedAt: 1 });
        await store.delete('a');
        expect((await store.list())).toEqual([]);
    });

    test('clearObsolete strips legacy global_iteration_history but leaves v2 bucket intact', async () => {
        settingsRoot.global_iteration_history = { stale: true };
        await store.save({ id: 'a', title: 'one', messages: [], updatedAt: 1 });
        await store.clearObsolete();
        expect(settingsRoot.global_iteration_history).toBeUndefined();
        // v2 bucket should still hold our session
        const list = await store.list();
        expect(list).toHaveLength(1);
    });

    test('per-mode + per-scope bucketing keeps spec/loop and global/character separate', async () => {
        const specGlobalStore = store;
        const specCharStore = createOrchestratorIterationSessionStore({
            mode: 'spec',
            getOrchestratorSettingsRoot: () => settingsRoot,
            persistSettings: () => {},
            computeScope: () => 'character_abc',
        });
        const loopGlobalStore = createOrchestratorIterationSessionStore({
            mode: 'loop',
            getOrchestratorSettingsRoot: () => settingsRoot,
            persistSettings: () => {},
            computeScope: () => 'global',
        });
        await specGlobalStore.save({ id: 'sg', title: 'spec-global', messages: [], updatedAt: 1 });
        await specCharStore.save({ id: 'sc', title: 'spec-char', messages: [], updatedAt: 2 });
        await loopGlobalStore.save({ id: 'lg', title: 'loop-global', messages: [], updatedAt: 3 });
        expect((await specGlobalStore.list()).map(s => s.id)).toEqual(['sg']);
        expect((await specCharStore.list()).map(s => s.id)).toEqual(['sc']);
        expect((await loopGlobalStore.list()).map(s => s.id)).toEqual(['lg']);
    });
});

describe('Orchestrator iter-studio session — new message schema persistence', () => {
    let settingsRoot;
    let store;

    beforeEach(() => {
        settingsRoot = {};
        store = createOrchestratorIterationSessionStore({
            mode: 'spec',
            getOrchestratorSettingsRoot: () => settingsRoot,
            persistSettings: () => { /* no-op */ },
            computeScope: () => 'global',
        });
    });

    test('save+load round-trips id/at/toolCalls/edits/appliedAt/appliedTarget/rolledBackAt/auto + pendingEdits + surfaceState.isFinalized', async () => {
        const session = {
            id: 'rt-1',
            title: 'Round trip',
            createdAt: 1,
            updatedAt: 1,
            summary: '',
            mode: 'spec',
            surfaceState: {
                historyOpen: false,
                autoApply: true,
                isFinalized: true,
                finalizeSummary: 'Bumped reviewer max_rounds.',
            },
            messages: [
                { id: 'm1', role: 'user', content: 'Bump reviewer max_rounds to 4', at: 100 },
                {
                    id: 'm2', role: 'assistant', content: 'Done.', at: 200,
                    toolCalls: [{ name: 'orch_set_stage_field', args: { stageId: 'stage_1', field: 'max_rounds', value: 4 } }],
                    edits: [{ op: 'set', path: '', oldValue: { spec: {}, presets: {} }, newValue: { spec: { stages: [] }, presets: {} } }],
                    appliedAt: 300,
                    appliedTarget: 'global',
                    rolledBackAt: null,
                },
                { id: 'm3', role: 'user', content: 'Continue', at: 400, auto: true },
            ],
            pendingEdits: [{ op: 'set', path: '', oldValue: {}, newValue: { spec: { stages: [{ id: 'review', mode: 'serial' }] } } }],
        };
        await store.save(session);
        const loaded = await store.load('rt-1');
        expect(loaded).not.toBeNull();
        expect(loaded.messages).toHaveLength(3);
        expect(loaded.messages[0]).toEqual(session.messages[0]);
        expect(loaded.messages[1].toolCalls).toEqual(session.messages[1].toolCalls);
        expect(loaded.messages[1].edits).toEqual(session.messages[1].edits);
        expect(loaded.messages[1].appliedAt).toBe(300);
        expect(loaded.messages[1].appliedTarget).toBe('global');
        expect(loaded.messages[1].rolledBackAt).toBeNull();
        // Synthetic auto-continue user message preserves auto flag.
        expect(loaded.messages[2].auto).toBe(true);
        // pendingEdits at the session top level survives.
        expect(loaded.pendingEdits).toEqual(session.pendingEdits);
        // surfaceState round-trips, including the new finalize fields.
        expect(loaded.surfaceState.isFinalized).toBe(true);
        expect(loaded.surfaceState.finalizeSummary).toBe('Bumped reviewer max_rounds.');
        expect(loaded.surfaceState.autoApply).toBe(true);
    });

    test('save+load preserves rolledBackAt timestamp (not null)', async () => {
        const session = {
            id: 'rb-1', title: '', createdAt: 1, updatedAt: 1, summary: '', mode: 'spec', surfaceState: {},
            messages: [{
                id: 'm1', role: 'assistant', content: 'done', at: 100,
                toolCalls: [{ name: 'orch_set_stage_field', args: {} }],
                edits: [{ op: 'set', path: '', oldValue: {}, newValue: { spec: { stages: [] } } }],
                appliedAt: 200, appliedTarget: 'character', rolledBackAt: 500,
            }],
        };
        await store.save(session);
        const loaded = await store.load('rb-1');
        expect(loaded.messages[0].rolledBackAt).toBe(500);
        expect(loaded.messages[0].appliedTarget).toBe('character');
    });
});

describe('Orchestrator iter-studio — normalizeMessageShape (legacy message migration)', () => {
    test('regenerates id for legacy messages without one', () => {
        const legacy = { role: 'user', content: 'old' };
        const normalized = normalizeMessageShape(legacy, 5000);
        expect(normalized.id).toMatch(/^orch_msg_/);
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
            toolCalls: [{ name: 'orch_set_stage_field' }],
            edits: [{ op: 'set', path: '', oldValue: {}, newValue: {} }],
            appliedAt: 200, appliedTarget: 'character',
            rolledBackAt: 300,
            auto: true,
        }, 1);
        expect(n.toolCalls).toEqual([{ name: 'orch_set_stage_field' }]);
        expect(n.edits).toEqual([{ op: 'set', path: '', oldValue: {}, newValue: {} }]);
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

describe('Orchestrator iter-studio — makeMessageId', () => {
    test('produces unique orch_msg_-prefixed ids', () => {
        const a = makeMessageId();
        const b = makeMessageId();
        expect(a).toMatch(/^orch_msg_/);
        expect(b).toMatch(/^orch_msg_/);
        expect(a).not.toBe(b);
    });
});
