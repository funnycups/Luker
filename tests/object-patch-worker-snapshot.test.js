import { describe, expect, test } from '@jest/globals';

import {
    applyCommittedSnapshotOperations,
    createObjectPatchWorkerState,
    handleObjectPatchWorkerMessage,
} from '../public/scripts/workers/object-patch-worker.js';

describe('object-patch-worker stateful serialized snapshot protocol', () => {
    test('retains committed snapshot across saves without resending previousState and rolls back on discard', () => {
        const workerState = createObjectPatchWorkerState();
        const initial = {
            username: 'Alice',
            oai_settings: {
                temperature: 0.7,
                prompts: [{ identifier: 'main', content: 'Stay in character.' }],
            },
            extension_settings: {
                example: { enabled: true, items: ['a', 'b'] },
            },
        };

        const firstEdit = {
            ...initial,
            oai_settings: {
                ...initial.oai_settings,
                temperature: 0.9,
            },
        };

        // First diff seeds previousSerialized because worker is cold
        const firstReply = handleObjectPatchWorkerMessage(workerState, {
            id: 1,
            action: 'diffSerializedSnapshot',
            snapshotKey: 'settings',
            previousSerialized: JSON.stringify(initial),
            nextSerialized: JSON.stringify(firstEdit),
            maxOperations: 4000,
            attachTests: true,
        });

        expect(firstReply).toEqual({
            id: 1,
            ok: true,
            operations: [
                { op: 'test', path: '/oai_settings/temperature', value: 0.7 },
                { op: 'replace', path: '/oai_settings/temperature', value: 0.9 },
            ],
        });

        // Simulate failed HTTP save -> discard staged snapshot
        handleObjectPatchWorkerMessage(workerState, {
            action: 'discardSnapshot',
            stageId: 1,
        });

        // Retry after failed save without resending previousSerialized:
        // seeding from previousSerialized preserves the committed baseline while discarding firstEdit.
        const retryReply = handleObjectPatchWorkerMessage(workerState, {
            id: 2,
            action: 'diffSerializedSnapshot',
            snapshotKey: 'settings',
            nextSerialized: JSON.stringify(firstEdit),
            maxOperations: 4000,
            attachTests: true,
        });

        expect(retryReply).toEqual({
            id: 2,
            ok: true,
            operations: [
                { op: 'test', path: '/oai_settings/temperature', value: 0.7 },
                { op: 'replace', path: '/oai_settings/temperature', value: 0.9 },
            ],
        });

        // Commit the retried attempt after HTTP patch succeeds
        handleObjectPatchWorkerMessage(workerState, {
            action: 'commitSnapshot',
            stageId: 2,
        });

        // Update main-thread snapshot incrementally without re-parsing the full JSON payload
        const updatedMainSnapshot = applyCommittedSnapshotOperations(
            structuredClone(initial),
            retryReply.operations,
        );
        expect(updatedMainSnapshot).toEqual(firstEdit);

        // Second edit sends ONLY nextSerialized (zero previousState transfer!)
        const secondEdit = {
            ...firstEdit,
            extension_settings: {
                example: { enabled: false, items: ['a', 'b', 'c'] },
            },
        };

        const secondReply = handleObjectPatchWorkerMessage(workerState, {
            id: 3,
            action: 'diffSerializedSnapshot',
            snapshotKey: 'settings',
            nextSerialized: JSON.stringify(secondEdit),
            maxOperations: 4000,
            attachTests: true,
        });

        expect(secondReply.ok).toBe(true);
        expect(secondReply.operations).toHaveLength(3);
        expect(secondReply.operations).toEqual(expect.arrayContaining([
            { op: 'test', path: '/extension_settings/example/enabled', value: true },
            { op: 'replace', path: '/extension_settings/example/enabled', value: false },
            { op: 'add', path: '/extension_settings/example/items/2', value: 'c' },
        ]));
        const finalMainSnapshot = applyCommittedSnapshotOperations(
            updatedMainSnapshot,
            secondReply.operations,
        );
        expect(finalMainSnapshot).toEqual(secondEdit);
    });

    test('preserves legacy stateless message handling for existing callers', () => {
        const workerState = createObjectPatchWorkerState();
        const reply = handleObjectPatchWorkerMessage(workerState, {
            id: 42,
            previousState: { a: 1 },
            nextState: { a: 2 },
            maxOperations: 2000,
            attachTests: true,
        });

        expect(reply).toEqual({
            id: 42,
            ok: true,
            operations: [
                { op: 'test', path: '/a', value: 1 },
                { op: 'replace', path: '/a', value: 2 },
            ],
        });
    });
});
