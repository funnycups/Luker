/**
 * loop-tools/note tests (Plan Task 11).
 *
 * note.add persists per-chat notes through floor-state with namespace
 * `luker_orch_loop_notes`. Notes survive across loop runs and are
 * re-injected into the agent's system prompt at the start of each run
 * (so the agent can see what it told itself last turn).
 *
 * Wiring:
 *   - Production: loop-runtime calls `attachNotesFloorState(context)` at
 *     run start to mount the floor-state namespace + populate
 *     `context.__loopNotes`.
 *   - Tests: inject through `context.__floorStateForNotes`, an adapter
 *     exposing `appendForFloor(floor, text)` /
 *     `listAcrossFloors(): string[]` / `pruneOldest(n)`. The production
 *     adapter wraps the real floor-state instance behind these same call
 *     names so the tool doesn't have to care which path it's on.
 *
 * Constraints:
 *   - Empty / whitespace-only text → ToolError(NOTE_EMPTY)
 *   - Text > 1KB UTF-8 → ToolError(NOTE_TOO_LONG)
 *   - LRU 50 notes total: pruneOldest is invoked when list grows past 50
 *   - Floor binding: `context.__targetFloorForNote ?? max(0, chat.length-1)`
 */

import { describe, test, expect } from '@jest/globals';

import {
    execNoteAdd,
    loadAllNotes,
} from '../../public/scripts/extensions/orchestrator/loop-tools/note.js';
import {
    executeLoopTool,
    getEnabledToolSchemas,
} from '../../public/scripts/extensions/orchestrator/loop-tools.js';
import { ToolError } from '../../public/scripts/extensions/orchestrator/loop-runtime.js';

function makeFakeFloorState() {
    const stored = []; // { floor, text }
    return {
        stored,
        appendForFloor: async (floor, text) => {
            stored.push({ floor, text });
        },
        listAcrossFloors: async () => stored.map(s => s.text),
        pruneOldest: async (n) => {
            if (n > 0) stored.splice(0, Math.min(n, stored.length));
        },
    };
}

function makeContext({ floor, chat = [] } = {}) {
    const fs = makeFakeFloorState();
    return {
        ctx: {
            chat,
            __targetFloorForNote: floor,
            __floorStateForNotes: fs,
        },
        fs,
    };
}

describe('execNoteAdd (Task 11)', () => {
    test('appends note via appendForFloor with the configured target floor', async () => {
        const { ctx, fs } = makeContext({ floor: 5 });
        const r = await execNoteAdd({ text: 'remember the lighthouse' }, ctx);
        expect(r).toEqual({ ok: true });
        expect(fs.stored).toEqual([{ floor: 5, text: 'remember the lighthouse' }]);
    });

    test('default target floor = max(0, chat.length-1) when __targetFloorForNote missing', async () => {
        const { ctx, fs } = makeContext({ chat: [{ mes: 'a' }, { mes: 'b' }, { mes: 'c' }] });
        await execNoteAdd({ text: 'note A' }, ctx);
        expect(fs.stored).toEqual([{ floor: 2, text: 'note A' }]);
    });

    test('empty chat falls back to floor 0', async () => {
        const { ctx, fs } = makeContext({ chat: [] });
        await execNoteAdd({ text: 'first note' }, ctx);
        expect(fs.stored[0].floor).toBe(0);
    });

    test('rejects empty text', async () => {
        const { ctx } = makeContext({ floor: 0 });
        await expect(execNoteAdd({ text: '' }, ctx)).rejects.toBeInstanceOf(ToolError);
    });

    test('rejects whitespace-only text', async () => {
        const { ctx } = makeContext({ floor: 0 });
        await expect(execNoteAdd({ text: '    \n  \t  ' }, ctx)).rejects.toThrow(/non-empty/i);
    });

    test('rejects text > 1KB UTF-8', async () => {
        const { ctx } = makeContext({ floor: 0 });
        const big = 'a'.repeat(1100);
        await expect(execNoteAdd({ text: big }, ctx)).rejects.toThrow(/too long/i);
    });

    test('accepts text exactly at 1KB boundary', async () => {
        const { ctx, fs } = makeContext({ floor: 0 });
        const exact = 'a'.repeat(1024);
        await execNoteAdd({ text: exact }, ctx);
        expect(fs.stored[0].text).toBe(exact);
    });

    test('trims leading/trailing whitespace before storage', async () => {
        const { ctx, fs } = makeContext({ floor: 0 });
        await execNoteAdd({ text: '   hello world   ' }, ctx);
        expect(fs.stored[0].text).toBe('hello world');
    });

    test('LRU prune kicks in past 50 notes', async () => {
        const { ctx, fs } = makeContext({ floor: 0 });
        for (let i = 0; i < 51; i += 1) {
            await execNoteAdd({ text: `note ${i}` }, ctx);
        }
        expect(fs.stored).toHaveLength(50);
        // Oldest dropped → first surviving should be note 1, last note 50
        expect(fs.stored[0].text).toBe('note 1');
        expect(fs.stored[49].text).toBe('note 50');
    });

    test('UTF-8 byte length is what gets validated, not character count', async () => {
        // 4-byte char × 257 = 1028 bytes (just over 1024)
        const { ctx } = makeContext({ floor: 0 });
        const overByteLimit = '😀'.repeat(257);
        await expect(execNoteAdd({ text: overByteLimit }, ctx)).rejects.toThrow(/too long/i);
        // 4-byte char × 256 = 1024 bytes (exactly at the limit)
        const atByteLimit = '😀'.repeat(256);
        const { ctx: ctx2, fs } = makeContext({ floor: 0 });
        await execNoteAdd({ text: atByteLimit }, ctx2);
        expect(fs.stored).toHaveLength(1);
    });
});

describe('loadAllNotes (Task 11)', () => {
    test('returns the in-order list of notes from listAcrossFloors', async () => {
        const { ctx, fs } = makeContext({ floor: 0 });
        await execNoteAdd({ text: 'first' }, ctx);
        await execNoteAdd({ text: 'second' }, ctx);
        await execNoteAdd({ text: 'third' }, ctx);
        const all = await loadAllNotes(ctx);
        expect(all).toEqual(['first', 'second', 'third']);
        expect(fs.stored.map(s => s.text)).toEqual(all);
    });

    test('returns [] when floor-state is unavailable (graceful)', async () => {
        const ctx = {}; // no __floorStateForNotes
        const all = await loadAllNotes(ctx);
        expect(all).toEqual([]);
    });
});

describe('central dispatcher includes note.add (Task 11)', () => {
    test('executeLoopTool dispatches note.add', async () => {
        const { ctx, fs } = makeContext({ floor: 0 });
        const r = await executeLoopTool('note.add', { text: 'a routed note' }, ctx);
        expect(r).toEqual({ ok: true });
        expect(fs.stored[0].text).toBe('a routed note');
    });

    test('getEnabledToolSchemas includes note.add when flagged on', () => {
        const schemas = getEnabledToolSchemas({
            tools: {
                finalize: true,
                chat: { read_range: false, search: false },
                lorebook: { search: false, get: false },
                memory: { search: false, list_recent: false, get: false },
                note: { add: true },
            },
        });
        const names = schemas.map(s => s?.function?.name);
        expect(names).toContain('note.add');
    });

    test('getEnabledToolSchemas omits note.add when flagged off', () => {
        const schemas = getEnabledToolSchemas({
            tools: { finalize: true, note: { add: false } },
        });
        const names = schemas.map(s => s?.function?.name);
        expect(names).not.toContain('note.add');
    });
});

describe('runtime injects historical notes into the system prompt (Task 11)', () => {
    test('buildInitialMessages prepends a Previous Notes block when context.__loopNotes is non-empty', async () => {
        const { runLoopOrchestration } = await import(
            '../../public/scripts/extensions/orchestrator/loop-runtime.js'
        );
        const { jest } = await import('@jest/globals');

        let observedSystemPrompt = null;
        const sendLlm = jest.fn().mockImplementationOnce(async ({ messages }) => {
            observedSystemPrompt = messages.find(m => m.role === 'system')?.content || '';
            return {
                toolCalls: [{ id: 'tc1', name: 'finalize', args: { capsule_text: 'done' } }],
                assistantText: '',
            };
        });

        const profile = {
            mode: 'loop',
            apiPresetName: '',
            promptPresetName: '',
            system_prompt: 'You are a research agent.',
            tools: {
                note: { add: true },
                chat: { read_range: false, search: false },
                lorebook: { search: false, get: false },
                memory: { search: false, list_recent: false, get: false },
                finalize: true,
            },
            max_rounds: 5,
            wall_clock_budget_ms: 60000,
            capsule_inject: { position: 'atDepth', depth: 0, role: 'system', customInstruction: '' },
        };

        const context = {
            chat: [],
            __loopNotes: ['note one', 'note two'],
        };
        const payload = {
            signal: new AbortController().signal,
            coreChat: [],
        };

        const result = await runLoopOrchestration(context, payload, profile, { sendLlm });
        expect(result.status).toBe('completed');
        expect(observedSystemPrompt).toContain('You are a research agent.');
        expect(observedSystemPrompt).toContain('Previous Notes');
        expect(observedSystemPrompt).toContain('1. note one');
        expect(observedSystemPrompt).toContain('2. note two');
    });

    test('buildInitialMessages omits the Previous Notes block when notes is empty', async () => {
        const { runLoopOrchestration } = await import(
            '../../public/scripts/extensions/orchestrator/loop-runtime.js'
        );
        const { jest } = await import('@jest/globals');

        let observedSystemPrompt = null;
        const sendLlm = jest.fn().mockImplementationOnce(async ({ messages }) => {
            observedSystemPrompt = messages.find(m => m.role === 'system')?.content || '';
            return {
                toolCalls: [{ id: 'tc1', name: 'finalize', args: { capsule_text: 'done' } }],
                assistantText: '',
            };
        });

        const profile = {
            mode: 'loop',
            apiPresetName: '',
            promptPresetName: '',
            system_prompt: 'You are a research agent.',
            tools: {
                note: { add: false },
                chat: { read_range: false, search: false },
                lorebook: { search: false, get: false },
                memory: { search: false, list_recent: false, get: false },
                finalize: true,
            },
            max_rounds: 5,
            wall_clock_budget_ms: 60000,
            capsule_inject: { position: 'atDepth', depth: 0, role: 'system', customInstruction: '' },
        };

        const context = {
            chat: [],
            __loopNotes: [],
        };
        const payload = {
            signal: new AbortController().signal,
            coreChat: [],
        };

        const result = await runLoopOrchestration(context, payload, profile, { sendLlm });
        expect(result.status).toBe('completed');
        expect(observedSystemPrompt).toBe('You are a research agent.');
        expect(observedSystemPrompt).not.toContain('Previous Notes');
    });
});
