/**
 * loop-tools/note tests.
 *
 * `note_open` persists per-chat notes through floor-state with namespace
 * `luker_orch_loop_notes`. Notes survive across loop runs and are
 * re-injected into the agent's system prompt as an `## Open Notes` block
 * at the start of each run (so the agent can see what it told itself
 * last turn). `note_close` flips an entry to `status: 'closed'` by id,
 * with an optional reason; closed entries stay in storage as history but
 * drop out of the prompt injection path.
 *
 * Wiring:
 *   - Production: loop-runtime calls `attachNotesFloorState(context)` at
 *     run start to mount the floor-state namespace + populate
 *     `context.__openNotes`.
 *   - Tests: inject through `context.__floorStateForNotes`, an adapter
 *     exposing `appendForFloor(floor, text): Promise<id>` /
 *     `listAcrossFloors(): Array<{id, text, status, closure_reason?}>` /
 *     `updateStatusById(id, status, reason)` /
 *     `updateTextById(id, text)` / `deleteByIds(ids)`. The production
 *     adapter wraps the real floor-state instance behind these same
 *     call names so the tool doesn't have to care which path it's on.
 *
 * Constraints:
 *   - Empty / whitespace-only text → ToolError(NOTE_EMPTY)
 *   - Text > 16 KiB UTF-8 → ToolError(NOTE_TOO_LONG)
 *   - `note_close` empty id → ToolError(NOTE_ID_EMPTY); not_found /
 *     already_closed surface as `{ ok: false, error }` not throws.
 *   - No LRU; closed notes are filtered out of the prompt injection path
 *   - Floor binding: `context.__targetFloorForNote ?? max(0, chat.length-1)`
 */

import { describe, test, expect } from '@jest/globals';

import {
    execNoteOpen,
    execNoteClose,
    loadAllNotes,
} from '../../public/scripts/extensions/orchestrator/loop-tools/note.js';
import {
    executeLoopTool,
    getEnabledToolSchemas,
} from '../../public/scripts/extensions/orchestrator/loop-tools.js';
import {
    ToolError,
    __testBuildInitialMessages,
} from '../../public/scripts/extensions/orchestrator/loop-runtime.js';

function makeFakeFloorState() {
    const stored = []; // { floor, id, text }
    let counter = 0;
    const mintId = () => `t_${++counter}`;
    return {
        stored,
        appendForFloor: async (floor, text) => {
            const id = mintId();
            stored.push({ floor, id, text });
            return id;
        },
        listAcrossFloors: async () => stored.map(s => ({ id: s.id, text: s.text })),
        deleteByIds: async (ids) => {
            const target = new Set(Array.isArray(ids) ? ids.map(s => String(s)) : []);
            const present = new Set(stored.map(s => s.id));
            const removed = [];
            for (let i = stored.length - 1; i >= 0; i -= 1) {
                if (target.has(stored[i].id)) {
                    removed.push(stored[i].id);
                    stored.splice(i, 1);
                }
            }
            const missing = [];
            for (const id of target) {
                if (!present.has(id)) missing.push(id);
            }
            return { removed, missing };
        },
    };
}

function makeContext({ floor, chat = [] } = {}) {
    const fs = makeFakeFloorState();
    const ctx = {
        chat,
        __targetFloorForNote: floor,
        __floorStateForNotes: fs,
    };
    return { ctx, fs };
}

function makeAdapter(initial = []) {
    const entries = initial.map(e => ({ ...e }));
    return {
        appendForFloor: async (_floor, text) => {
            const id = `n${entries.length + 1}`;
            entries.push({ id, text, status: 'open' });
            return id;
        },
        listAcrossFloors: async () => entries.map(e => ({ ...e })),
        updateStatusById: async (id, status, reason) => {
            const found = entries.find(e => e.id === id);
            if (!found) return { ok: false, error: 'not_found' };
            if (found.status === status) return { ok: false, error: 'already_' + status };
            found.status = status;
            if (typeof reason === 'string') found.closure_reason = reason;
            return { ok: true };
        },
        updateTextById: async (id, text) => {
            const found = entries.find(e => e.id === id);
            if (!found) return { ok: false, error: 'not_found' };
            found.text = text;
            return { ok: true };
        },
        deleteByIds: async (ids) => {
            const removed = [];
            for (const id of ids) {
                const idx = entries.findIndex(e => e.id === id);
                if (idx >= 0) { removed.push(id); entries.splice(idx, 1); }
            }
            return { removed, missing: ids.filter(i => !removed.includes(i)) };
        },
        __entries: entries,
    };
}

describe('notes adapter status state machine', () => {
    test('new note defaults to status=open', async () => {
        const fs = makeAdapter();
        await fs.appendForFloor(0, 'planted key');
        expect(fs.__entries[0]).toEqual({ id: 'n1', text: 'planted key', status: 'open' });
    });

    test('updateStatusById flips open → closed with reason', async () => {
        const fs = makeAdapter();
        const id = await fs.appendForFloor(0, 'planted key');
        const r = await fs.updateStatusById(id, 'closed', 'used by hero at floor 53');
        expect(r).toEqual({ ok: true });
        expect(fs.__entries[0]).toMatchObject({ status: 'closed', closure_reason: 'used by hero at floor 53' });
    });

    test('updateStatusById on already-closed reports already_closed', async () => {
        const fs = makeAdapter();
        const id = await fs.appendForFloor(0, 'x');
        await fs.updateStatusById(id, 'closed', 'r1');
        const r = await fs.updateStatusById(id, 'closed', 'r2');
        expect(r).toEqual({ ok: false, error: 'already_closed' });
    });
});

describe('notes adapter user-only ops', () => {
    test('updateTextById changes text without altering status', async () => {
        const fs = makeAdapter();
        const id = await fs.appendForFloor(0, 'original');
        await fs.updateStatusById(id, 'closed', 'r');
        const r = await fs.updateTextById(id, 'corrected');
        expect(r.ok).toBe(true);
        const all = await fs.listAcrossFloors();
        expect(all[0]).toMatchObject({ id, text: 'corrected', status: 'closed', closure_reason: 'r' });
    });

    test('deleteByIds removes entries entirely (hard delete)', async () => {
        const fs = makeAdapter();
        const id1 = await fs.appendForFloor(0, 'a');
        const id2 = await fs.appendForFloor(0, 'b');
        const r = await fs.deleteByIds([id1, 'nope']);
        expect(r.removed).toEqual([id1]);
        expect(r.missing).toEqual(['nope']);
        const all = await fs.listAcrossFloors();
        expect(all).toHaveLength(1);
        expect(all[0].id).toBe(id2);
    });
});

describe('execNoteOpen', () => {
    test('appends note via appendForFloor with the configured target floor', async () => {
        const { ctx, fs } = makeContext({ floor: 5 });
        const r = await execNoteOpen({ text: 'remember the lighthouse' }, ctx);
        expect(r).toEqual({ id: expect.any(String) });
        expect(fs.stored).toEqual([expect.objectContaining({ floor: 5, text: 'remember the lighthouse' })]);
    });

    test('default target floor = max(0, chat.length-1) when __targetFloorForNote missing', async () => {
        const { ctx, fs } = makeContext({ chat: [{ mes: 'a' }, { mes: 'b' }, { mes: 'c' }] });
        await execNoteOpen({ text: 'note A' }, ctx);
        expect(fs.stored).toEqual([expect.objectContaining({ floor: 2, text: 'note A' })]);
    });

    test('empty chat falls back to floor 0', async () => {
        const { ctx, fs } = makeContext({ chat: [] });
        await execNoteOpen({ text: 'first note' }, ctx);
        expect(fs.stored[0].floor).toBe(0);
    });

    test('rejects empty text', async () => {
        const { ctx } = makeContext({ floor: 0 });
        await expect(execNoteOpen({ text: '' }, ctx)).rejects.toBeInstanceOf(ToolError);
    });

    test('rejects whitespace-only text', async () => {
        const { ctx } = makeContext({ floor: 0 });
        await expect(execNoteOpen({ text: '    \n  \t  ' }, ctx)).rejects.toThrow(/non-empty/i);
    });

    test('rejects text > 16KB UTF-8', async () => {
        const { ctx } = makeContext({ floor: 0 });
        const big = 'a'.repeat(16 * 1024 + 1);
        await expect(execNoteOpen({ text: big }, ctx)).rejects.toThrow(/too long/i);
    });

    test('accepts text exactly at 16KB boundary', async () => {
        const { ctx, fs } = makeContext({ floor: 0 });
        const exact = 'a'.repeat(16 * 1024);
        await execNoteOpen({ text: exact }, ctx);
        expect(fs.stored[0].text).toBe(exact);
    });

    test('trims leading/trailing whitespace before storage', async () => {
        const { ctx, fs } = makeContext({ floor: 0 });
        await execNoteOpen({ text: '   hello world   ' }, ctx);
        expect(fs.stored[0].text).toBe('hello world');
    });

    test('UTF-8 byte length is what gets validated, not character count', async () => {
        // 4-byte char × 4097 = 16388 bytes (just over 16384)
        const { ctx } = makeContext({ floor: 0 });
        const overByteLimit = '😀'.repeat(4097);
        await expect(execNoteOpen({ text: overByteLimit }, ctx)).rejects.toThrow(/too long/i);
        // 4-byte char × 4096 = 16384 bytes (exactly at the limit)
        const atByteLimit = '😀'.repeat(4096);
        const { ctx: ctx2, fs } = makeContext({ floor: 0 });
        await execNoteOpen({ text: atByteLimit }, ctx2);
        expect(fs.stored).toHaveLength(1);
    });
});

describe('loadAllNotes', () => {
    test('returns the in-order list of notes from listAcrossFloors', async () => {
        const { ctx, fs } = makeContext({ floor: 0 });
        await execNoteOpen({ text: 'first' }, ctx);
        await execNoteOpen({ text: 'second' }, ctx);
        await execNoteOpen({ text: 'third' }, ctx);
        const all = await loadAllNotes(ctx);
        expect(all).toEqual([
            expect.objectContaining({ text: 'first' }),
            expect.objectContaining({ text: 'second' }),
            expect.objectContaining({ text: 'third' }),
        ]);
        expect(fs.stored.map(s => s.text)).toEqual(all.map(n => n.text));
    });

    test('returns [] when floor-state is unavailable (graceful)', async () => {
        const ctx = {}; // no __floorStateForNotes
        const all = await loadAllNotes(ctx);
        expect(all).toEqual([]);
    });
});

describe('central dispatcher routes note_open / note_close', () => {
    test('executeLoopTool dispatches note_open', async () => {
        const { ctx, fs } = makeContext({ floor: 0 });
        const r = await executeLoopTool('note_open', { text: 'a routed note' }, ctx);
        expect(r).toMatchObject({ id: expect.any(String) });
        expect(fs.stored[0].text).toBe('a routed note');
    });

    test('executeLoopTool dispatches note_close', async () => {
        const fs = makeAdapter();
        const ctx = { __floorStateForNotes: fs, chat: [{}, {}] };
        const { id } = await execNoteOpen({ text: 'a routed note' }, ctx);
        const r = await executeLoopTool('note_close', { id, reason: 'done' }, ctx);
        expect(r).toEqual({ ok: true });
        const all = await fs.listAcrossFloors();
        expect(all[0]).toMatchObject({ status: 'closed', closure_reason: 'done' });
    });

    test('getEnabledToolSchemas includes note_open when flagged on', () => {
        const schemas = getEnabledToolSchemas({
            tools: {
                finalize: true,
                chat: { read_range: false, search: false },
                lorebook: { search: false, get: false },
                memory: { search: false, list_recent: false, get: false },
                note: { open: true },
            },
        });
        const names = schemas.map(s => s?.function?.name);
        expect(names).toContain('note_open');
    });

    test('getEnabledToolSchemas omits note_open when flagged off', () => {
        const schemas = getEnabledToolSchemas({
            tools: { finalize: true, note: { open: false } },
        });
        const names = schemas.map(s => s?.function?.name);
        expect(names).not.toContain('note_open');
    });

    test('getEnabledToolSchemas includes note_close when flagged on', () => {
        const schemas = getEnabledToolSchemas({
            tools: {
                finalize: true,
                chat: { read_range: false, search: false },
                lorebook: { search: false, get: false },
                memory: { search: false, list_recent: false, get: false },
                note: { open: true, close: true },
            },
        });
        const names = schemas.map(s => s?.function?.name);
        expect(names).toContain('note_close');
    });

    test('getEnabledToolSchemas omits note_close when flagged off', () => {
        const schemas = getEnabledToolSchemas({
            tools: { finalize: true, note: { open: true, close: false } },
        });
        const names = schemas.map(s => s?.function?.name);
        expect(names).not.toContain('note_close');
        // note_open stays on independently
        expect(names).toContain('note_open');
    });
});

describe('note_close tool', () => {
    test('closes an open note by id with reason', async () => {
        const fs = makeAdapter();
        const ctx = { __floorStateForNotes: fs, chat: [{}, {}] };
        const { id } = await execNoteOpen({ text: 'planted key' }, ctx);
        const r = await execNoteClose({ id, reason: 'used by hero' }, ctx);
        expect(r).toEqual({ ok: true });
        const all = await fs.listAcrossFloors();
        expect(all[0]).toMatchObject({ status: 'closed', closure_reason: 'used by hero' });
    });

    test('closing already-closed returns ok:false / error:already_closed (no throw)', async () => {
        const fs = makeAdapter();
        const ctx = { __floorStateForNotes: fs, chat: [{}, {}] };
        const { id } = await execNoteOpen({ text: 'x' }, ctx);
        await execNoteClose({ id, reason: 'r1' }, ctx);
        const r = await execNoteClose({ id, reason: 'r2' }, ctx);
        expect(r.ok).toBe(false);
        expect(r.error).toBe('already_closed');
    });

    test('closing unknown id returns ok:false / error:not_found', async () => {
        const fs = makeAdapter();
        const ctx = { __floorStateForNotes: fs, chat: [{}, {}] };
        const r = await execNoteClose({ id: 'nope', reason: '' }, ctx);
        expect(r.ok).toBe(false);
        expect(r.error).toBe('not_found');
    });

    test('reason is optional', async () => {
        const fs = makeAdapter();
        const ctx = { __floorStateForNotes: fs, chat: [{}, {}] };
        const { id } = await execNoteOpen({ text: 'x' }, ctx);
        const r = await execNoteClose({ id }, ctx);
        expect(r).toEqual({ ok: true });
    });
});

describe('buildInitialMessages renders ## Open Notes', () => {
    test('renders open notes with id prefix, omits closed and floor', () => {
        const ctx = {
            __openNotes: [
                { id: 'o_a3f2', text: 'planted key', status: 'open' },
                { id: 'o_b8c1', text: 'sanctum oath', status: 'open' },
            ],
        };
        const profile = { system_prompt: 'You are a writer.' };
        const messages = __testBuildInitialMessages(ctx, null, profile);
        const sys = messages.find(m => m.role === 'system')?.content || '';
        expect(sys).toContain('## Open Notes');
        expect(sys).toContain('[o_a3f2] planted key');
        expect(sys).toContain('[o_b8c1] sanctum oath');
        expect(sys).not.toMatch(/floor\s+\d+/);
    });

    test('omits the Open Notes block when nothing is open', () => {
        const ctx = { __openNotes: [] };
        const profile = { system_prompt: 'You are a writer.' };
        const messages = __testBuildInitialMessages(ctx, null, profile);
        const sys = messages.find(m => m.role === 'system')?.content || '';
        expect(sys).not.toContain('## Open Notes');
        expect(sys).not.toContain('## Previous Notes');
    });

    test('preserves the system_prompt body when no notes are open', () => {
        const ctx = { __openNotes: [] };
        const profile = { system_prompt: 'You are a writer.' };
        const messages = __testBuildInitialMessages(ctx, null, profile);
        const sys = messages.find(m => m.role === 'system')?.content || '';
        expect(sys).toBe('You are a writer.');
    });

    test('treats missing __openNotes as empty', () => {
        const ctx = {};
        const profile = { system_prompt: 'You are a writer.' };
        const messages = __testBuildInitialMessages(ctx, null, profile);
        const sys = messages.find(m => m.role === 'system')?.content || '';
        expect(sys).toBe('You are a writer.');
    });

    test('returns no messages when both system prompt and notes are empty', () => {
        const ctx = { __openNotes: [] };
        const profile = { system_prompt: '' };
        const messages = __testBuildInitialMessages(ctx, null, profile);
        expect(messages).toEqual([]);
    });
});

// Direct coverage of the production adapter built by `makeNotesAdapter` inside
// `attachNotesFloorState`. The other adapter-shape tests above use hand-rolled
// fakes that bypass the real builder; this block exercises the real builder
// against a fake floor-state whose update() returns false, the production-side
// signal that a chat-state patch was rejected.
describe('makeNotesAdapter surfaces write failures', () => {
    // Helper: build a fake floor-state instance shaped like the real one and
    // mount it via attachNotesFloorState. updateOk controls what every
    // fs.update returns; everything else is enough to satisfy the
    // attach guard.
    async function mountAdapterWith(updateOk) {
        const { attachNotesFloorState, resetNotesFloorStateInstanceForTesting } =
            await import('../../public/scripts/extensions/orchestrator/loop-runtime.js');
        resetNotesFloorStateInstanceForTesting();
        const fakeFs = {
            ready: async () => undefined,
            get: async () => ({}),
            update: async () => updateOk,
        };
        const ctx = { createFloorState: async () => fakeFs };
        await attachNotesFloorState(ctx);
        return ctx.__floorStateForNotes;
    }

    test('appendForFloor throws NOTE_WRITE_FAILED when fs.update returns false', async () => {
        const adapter = await mountAdapterWith(false);
        await expect(adapter.appendForFloor(0, 'lost')).rejects.toMatchObject({
            name: 'ToolError',
            code: 'NOTE_WRITE_FAILED',
        });
    });

    test('appendForFloor still returns the id when fs.update returns true', async () => {
        const adapter = await mountAdapterWith(true);
        const id = await adapter.appendForFloor(0, 'kept');
        expect(typeof id).toBe('string');
        expect(id.length).toBeGreaterThan(0);
    });

    test('updateStatusById throws NOTE_WRITE_FAILED on patch rejection of a real flip', async () => {
        // Seed an entry the reducer can find, then make fs.update return false
        // for the next call by toggling through a stateful fake.
        const { attachNotesFloorState, resetNotesFloorStateInstanceForTesting } =
            await import('../../public/scripts/extensions/orchestrator/loop-runtime.js');
        resetNotesFloorStateInstanceForTesting();
        let returnFromUpdate = true;
        let stored = { entries: [{ id: 'x', text: 't', status: 'open' }] };
        const fakeFs = {
            ready: async () => undefined,
            get: async () => stored,
            update: async (reducer) => {
                const next = await reducer(stored);
                if (returnFromUpdate && next && typeof next === 'object') stored = next;
                return returnFromUpdate;
            },
        };
        const ctx = { createFloorState: async () => fakeFs };
        await attachNotesFloorState(ctx);
        const adapter = ctx.__floorStateForNotes;

        returnFromUpdate = false;
        await expect(adapter.updateStatusById('x', 'closed', 'r')).rejects.toMatchObject({
            name: 'ToolError',
            code: 'NOTE_WRITE_FAILED',
        });
    });

    test('updateStatusById passes through no-op outcomes (not_found) without throwing', async () => {
        // The reducer's "no row matches" case is a legitimate result, not a
        // write rejection. We must not turn it into NOTE_WRITE_FAILED.
        const adapter = await mountAdapterWith(true);
        const r = await adapter.updateStatusById('missing', 'closed');
        expect(r).toEqual({ ok: false, error: 'not_found' });
    });

    test('deleteByIds throws NOTE_WRITE_FAILED only when an actual delete is rejected', async () => {
        const { attachNotesFloorState, resetNotesFloorStateInstanceForTesting } =
            await import('../../public/scripts/extensions/orchestrator/loop-runtime.js');
        resetNotesFloorStateInstanceForTesting();
        let returnFromUpdate = true;
        let stored = { entries: [{ id: 'a', text: 't', status: 'open' }] };
        const fakeFs = {
            ready: async () => undefined,
            get: async () => stored,
            update: async (reducer) => {
                const next = await reducer(stored);
                if (returnFromUpdate && next && typeof next === 'object') stored = next;
                return returnFromUpdate;
            },
        };
        const ctx = { createFloorState: async () => fakeFs };
        await attachNotesFloorState(ctx);
        const adapter = ctx.__floorStateForNotes;

        // Case 1: requested ids don't exist → no real delete attempted → no throw
        returnFromUpdate = false;
        const r1 = await adapter.deleteByIds(['ghost']);
        expect(r1).toEqual({ removed: [], missing: ['ghost'] });

        // Case 2: requested id exists, write rejected → throw
        returnFromUpdate = false;
        await expect(adapter.deleteByIds(['a'])).rejects.toMatchObject({
            name: 'ToolError',
            code: 'NOTE_WRITE_FAILED',
        });
    });
});
