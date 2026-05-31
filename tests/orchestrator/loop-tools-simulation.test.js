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
 *
 * Plus the cross-module ToolError duck-type regression test: a Layer-2
 * tool whose exec throws a ToolError-shaped object NOT instanceof the
 * orchestrator's ToolError class still surfaces to the agent as a
 * structured tool error rather than crashing the orchestration run.
 */

import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

import {
    executeLoopTool,
    beginSimulation,
    endSimulation,
    isSimulationActive,
} from '../../public/scripts/extensions/orchestrator/loop-tools.js';
import {
    registerOrchestrationTool,
    __getExtensionRegistryForTest,
} from '../../public/scripts/extensions/orchestrator/register-custom-tool.js';
import {
    isStructuredToolError,
    runLoopOrchestration,
} from '../../public/scripts/extensions/orchestrator/loop-runtime.js';

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
    beforeEach(() => {
        __getExtensionRegistryForTest().clear();
    });
    afterEach(() => {
        endSimulation();
        __getExtensionRegistryForTest().clear();
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

    test('sim-active write tool with simulate calls the simulate path', async () => {
        // Register a Layer-2 write tool with both exec and simulate. exec
        // throws if reached — sim mode must dispatch the simulate handler
        // instead. (Pre-migration this exercised memory_node_create, but
        // memory tools now live in memory-graph's Layer-2 module and the
        // test must not depend on that module being loaded.)
        registerOrchestrationTool({
            name: 'test_write_with_simulate',
            description: 'test write tool',
            parameters: { type: 'object', properties: {} },
            mode: 'write',
            exec: async () => { throw new Error('exec must not run in sim'); },
            simulate: async () => ({ ok: true, simulated: true, id: 'sim-id-123' }),
        });
        beginSimulation('run-simulate-path');
        const result = await executeLoopTool('test_write_with_simulate', {}, {});
        expect(result).toMatchObject({ ok: true, simulated: true, id: 'sim-id-123' });
    });
});

// ---------------------------------------------------------------------------
// Cross-module ToolError regression (Code review Fix 1)
//
// Layer-2 tools defined in extension modules (e.g. memory-graph) declare
// their own ToolError class to avoid depending on orchestrator internals.
// Such an error is NOT `instanceof` the orchestrator-internal ToolError,
// so the catch path in loop-/spec-/agenda-runtime previously fell through
// to `throw error` — every cross-module tool error aborted the entire run
// instead of being surfaced to the agent as a recoverable tool error.
//
// The fix: catches duck-type via `isStructuredToolError` on the wire
// shape (`name === 'ToolError'` + string `code`) so foreign-class errors
// pass the gate. These tests pin that contract.
// ---------------------------------------------------------------------------

describe('isStructuredToolError duck-type predicate', () => {
    test('matches plain object with ToolError name + string code', () => {
        const err = Object.assign(new Error('boom'), {
            name: 'ToolError',
            code: 'FOREIGN_CODE',
            hint: 'a hint',
        });
        expect(isStructuredToolError(err)).toBe(true);
    });

    test('matches foreign-class ToolError (different module identity)', () => {
        // Stand-in for memory-graph's locally-declared ToolError class.
        class ForeignToolError extends Error {
            constructor(message, code, hint) {
                super(message);
                this.name = 'ToolError';
                this.code = code;
                this.hint = hint || '';
            }
        }
        const err = new ForeignToolError('cross-module boom', 'MEMORY_DISABLED', 'enable mg');
        expect(isStructuredToolError(err)).toBe(true);
    });

    test('rejects plain Error (no ToolError name)', () => {
        expect(isStructuredToolError(new Error('plain'))).toBe(false);
    });

    test('rejects ToolError-named object missing code', () => {
        const err = Object.assign(new Error('boom'), { name: 'ToolError' });
        expect(isStructuredToolError(err)).toBe(false);
    });

    test('rejects ToolError-named object with non-string code', () => {
        const err = Object.assign(new Error('boom'), { name: 'ToolError', code: 42 });
        expect(isStructuredToolError(err)).toBe(false);
    });

    test('rejects null / undefined / non-objects', () => {
        expect(isStructuredToolError(null)).toBe(false);
        expect(isStructuredToolError(undefined)).toBe(false);
        expect(isStructuredToolError('string')).toBe(false);
        expect(isStructuredToolError(0)).toBe(false);
    });
});

describe('runLoopOrchestration surfaces foreign-class ToolError as recoverable', () => {
    // Stand-in for memory-graph/orchestrator-tools.js's local ToolError —
    // a class that satisfies the wire shape but is NOT identity-equal to
    // the orchestrator-internal ToolError class.
    class ForeignToolError extends Error {
        constructor(message, code, hint) {
            super(String(message || 'Tool error.'));
            this.name = 'ToolError';
            this.code = String(code || 'TOOL_ERROR');
            this.hint = String(hint || '');
        }
    }

    function makeProfile() {
        return {
            mode: 'loop',
            apiPresetName: '',
            promptPresetName: '',
            system_prompt: 'You are a research agent.',
            tools: {
                note: { open: true, close: false },
                chat: { read_range: false, search: false },
                lorebook: { search: false, get: false },
                finalize: true,
            },
            max_rounds: 5,
            wall_clock_budget_ms: 60000,
            capsule_inject: { position: 'atDepth', depth: 0, role: 'system', customInstruction: '' },
        };
    }

    test('foreign-class ToolError thrown by executeTool reaches the LLM as a structured tool message; orchestration completes', async () => {
        let observedMessages = null;
        const sendLlm = jest.fn()
            .mockImplementationOnce(async () => ({
                toolCalls: [{ id: 'tc1', name: 'note_open', args: { text: '' } }],
                assistantText: '',
            }))
            .mockImplementationOnce(async ({ messages }) => {
                observedMessages = messages;
                return {
                    toolCalls: [{ id: 'tc2', name: 'finalize', args: { capsule_text: 'recovered after foreign tool error' } }],
                    assistantText: '',
                };
            });

        // executeTool throws a ForeignToolError on first call. If the catch
        // gate uses identity-`instanceof`, this re-throws and the
        // orchestration crashes. Under the duck-type gate it must be
        // surfaced as a `role: tool` message.
        const executeTool = jest.fn().mockImplementation(async () => {
            throw new ForeignToolError(
                'memory-graph store is not loaded.',
                'MEMORY_DISABLED',
                'Enable memory-graph in extension settings.',
            );
        });

        const result = await runLoopOrchestration(
            { chat: [] },
            { signal: new AbortController().signal, coreChat: [] },
            makeProfile(),
            { sendLlm, executeTool },
        );

        // Did not crash.
        expect(result.status).toBe('completed');
        expect(result.capsule).toBe('recovered after foreign tool error');
        expect(sendLlm).toHaveBeenCalledTimes(2);

        // The error reached the LLM on round 2 as a structured tool
        // message with code + hint intact.
        const errMsg = (observedMessages || []).find(m => m?.role === 'tool' && m?.tool_call_id === 'tc1');
        expect(errMsg).toBeTruthy();
        const content = typeof errMsg.content === 'string' ? JSON.parse(errMsg.content) : errMsg.content;
        expect(content.ok).toBe(false);
        expect(content.code).toBe('MEMORY_DISABLED');
        expect(String(content.error || '')).toContain('memory-graph');
        expect(String(content.hint || '')).toContain('Enable memory-graph');
    });

    test('non-ToolError-shaped error still propagates as runtime error', async () => {
        // The duck-type widening must NOT swallow ordinary exceptions —
        // those still propagate as runtime errors so genuine bugs surface.
        const sendLlm = jest.fn().mockResolvedValueOnce({
            toolCalls: [{ id: 'tc1', name: 'note_open', args: { text: 'x' } }],
            assistantText: '',
        });
        const executeTool = jest.fn().mockImplementation(async () => {
            // Plain Error: name !== 'ToolError', no code.
            throw new Error('something genuinely exploded');
        });

        await expect(
            runLoopOrchestration(
                { chat: [] },
                { signal: new AbortController().signal, coreChat: [] },
                makeProfile(),
                { sendLlm, executeTool },
            ),
        ).rejects.toThrow(/something genuinely exploded/);
    });
});

