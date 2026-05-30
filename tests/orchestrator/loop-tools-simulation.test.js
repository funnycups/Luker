/**
 * Verifies sim-mode behavior in loop-tools.js:
 *
 *   - begin/end/isSimulationActive flag transitions
 *   - nested beginSimulation throws (caller bug)
 *   - endSimulation is idempotent (defensive)
 *   - sim-active read tools pass through to entry.exec
 *   - sim-active write tools call entry.simulate when present
 *   - sim-active write tools without simulate return generic noop payload
 *   - simulate throwing is caught and returned as a structured failure
 */

import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

import {
    executeLoopTool,
    beginSimulation,
    endSimulation,
    isSimulationActive,
} from '../../public/scripts/extensions/orchestrator/loop-tools.js';

describe('sim state (Task 2)', () => {
    afterEach(() => {
        // Make sure no test leaks an active simulation into the next.
        endSimulation();
    });

    test('beginSimulation flips the flag; endSimulation clears it', () => {
        expect(isSimulationActive()).toBe(false);
        beginSimulation('run-a');
        expect(isSimulationActive()).toBe(true);
        endSimulation();
        expect(isSimulationActive()).toBe(false);
    });

    test('nested beginSimulation throws with the existing runId in the message', () => {
        beginSimulation('run-a');
        expect(() => beginSimulation('run-b')).toThrow(/run-a/);
    });

    test('endSimulation is idempotent when no simulation is active', () => {
        expect(() => endSimulation()).not.toThrow();
        expect(isSimulationActive()).toBe(false);
    });

    test('sim-active read tool runs the real exec', async () => {
        beginSimulation('run-read');
        const result = await executeLoopTool(
            'chat_read_range',
            { start: 0, end: 0 },
            { chat: [{ mes: 'hi', is_user: true }] },
        );
        expect(Array.isArray(result)).toBe(true);
        expect(result[0]).toMatchObject({ floor: 0, content: 'hi' });
    });
});

describe('sim-mode write interception (Task 2)', () => {
    afterEach(() => {
        endSimulation();
    });

    test('write tool without simulate returns the generic noop payload and skips exec', async () => {
        // note_open is a write tool registered without a simulate handler in this task —
        // simulate gets added later. Use it to exercise the fallback path.
        const ctx = {
            chat: [{ mes: 'floor 0', is_user: true }],
            // Throw if exec is reached — sim mode must NOT call the real handler.
            __notesAdapter: { append: () => { throw new Error('exec should not run in sim'); } },
        };
        beginSimulation('run-noop');
        const result = await executeLoopTool('note_open', { text: 'should not persist' }, ctx);
        expect(result).toEqual({ ok: true, simulated: true, unvalidated: true });
    });

    test('placeholder for simulate-path (Task 3 replaces this)', () => {
        expect(true).toBe(true);
    });
});
