import { describe, expect, test } from '@jest/globals';
import * as iteration from '../../public/scripts/workbench/model/iterate.js';

function pendingDraft() {
    const bus = iteration.createIterateBus({ proposalKinds: ['profile-edit'] });
    bus.hydrate({
        version: 3,
        entries: [{
            id: 'profile-edit_1_saved',
            kind: 'profile-edit',
            status: 'pending',
            target: { type: 'profile', name: 'Harbor' },
            sourceCallId: 'edit-watch',
            meta: { before: { watch: 'dawn' }, after: { watch: 'dusk' } },
            inverse: [],
            forward: [],
        }],
        outcomeQueue: [],
    });
    return {
        base: { watch: 'dawn' },
        ai: { watch: 'dusk' },
        target: { scope: 'character', avatar: 'harbor.png' },
        title: 'Harbor',
        workKey: 'orch:character:harbor.png',
        ws: 'orch',
        proposalIds: ['profile-edit_1_saved'],
        changes: [{ key: 'proposal:profile-edit_1_saved' }],
        bus,
    };
}

describe('durable iteration drafts', () => {
    test('an empty turn proposal set preserves earlier pending entries', async () => {
        const { bus } = pendingDraft();
        const before = bus.serialize();

        const result = await iteration.commitTurnBatch({ bus, proposalIds: [] });

        expect(result.applied).toEqual([]);
        expect(bus.serialize()).toEqual(before);
    });

    test('captures working state without retaining mutable aliases or runtime bus methods', () => {
        expect(typeof iteration.serializeIterationDraft).toBe('function');
        const draft = pendingDraft();
        const snapshot = iteration.serializeIterationDraft(draft);

        expect(snapshot).toEqual({
            version: 1,
            base: { watch: 'dawn' },
            ai: { watch: 'dusk' },
            target: { scope: 'character', avatar: 'harbor.png' },
            title: 'Harbor',
            workKey: 'orch:character:harbor.png',
            ws: 'orch',
            proposalIds: ['profile-edit_1_saved'],
            busState: draft.bus.serialize(),
        });
        expect(snapshot).not.toHaveProperty('bus');
        draft.base.watch = 'noon';
        draft.ai.watch = 'midnight';
        draft.target.avatar = 'other.png';
        draft.bus.reject('profile-edit_1_saved');
        expect(snapshot.base.watch).toBe('dawn');
        expect(snapshot.ai.watch).toBe('dusk');
        expect(snapshot.target.avatar).toBe('harbor.png');
        expect(snapshot.busState.entries[0].status).toBe('pending');
    });

    test('restores an independent executable bus with the original proposal identity', () => {
        expect(typeof iteration.serializeIterationDraft).toBe('function');
        expect(typeof iteration.restoreIterationDraft).toBe('function');
        const snapshot = iteration.serializeIterationDraft(pendingDraft());
        const restored = iteration.restoreIterationDraft(snapshot, { proposalKinds: ['profile-edit'] });
        expect(restored.bus.listPending()).toEqual([{
            id: 'profile-edit_1_saved',
            sourceCallId: 'edit-watch',
        }]);
        expect(restored.bus.serialize()).toEqual(snapshot.busState);
        expect(restored.proposalIds).toEqual(['profile-edit_1_saved']);
        restored.ai.watch = 'midnight';
        restored.bus.reject('profile-edit_1_saved');
        expect(snapshot.ai.watch).toBe('dusk');
        expect(snapshot.busState.entries[0].status).toBe('pending');
    });

    test('restores a field-only draft without manufacturing a proposal bus', () => {
        expect(typeof iteration.serializeIterationDraft).toBe('function');
        expect(typeof iteration.restoreIterationDraft).toBe('function');
        const draft = { ...pendingDraft(), bus: null, proposalIds: [] };
        const snapshot = iteration.serializeIterationDraft(draft);
        expect(snapshot.busState).toBeNull();
        const restored = iteration.restoreIterationDraft(snapshot);
        expect(restored.bus).toBeNull();
        expect(restored.base).toEqual(draft.base);
        expect(restored.ai).toEqual(draft.ai);
    });

    test('reports an unsupported stored draft version with its owning session and turn', () => {
        expect(typeof iteration.restoreIterationDraft).toBe('function');
        const snapshot = { version: 2 };
        expect(() => iteration.restoreIterationDraft(snapshot, { sessionId: 'saved-watch', turnIndex: 1 }))
            .toThrow('Draft corrupted in session "saved-watch" turn[1]: unsupported version 2');
        expect(snapshot).toEqual({ version: 2 });
    });

    test('rejects an unsupported serialized bus instead of hydrating an empty replacement', () => {
        expect(typeof iteration.restoreIterationDraft).toBe('function');
        const snapshot = { version: 1, busState: { version: 4, entries: [], outcomeQueue: [] } };
        expect(() => iteration.restoreIterationDraft(snapshot, { sessionId: 'saved-watch', turnIndex: 1, proposalKinds: ['profile-edit'] }))
            .toThrow('Draft corrupted in session "saved-watch" turn[1]: unsupported proposal bus version 4');
    });
});
