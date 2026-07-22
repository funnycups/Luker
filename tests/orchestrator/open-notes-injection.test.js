/**
 * open-notes-injection.js unit tests.
 *
 * Cross-cutting: this shared helper is what every orchestration mode
 * (loop / director / spec / agenda) uses to surface the persistent
 * `## Open Notes` block into agent prompts. The invariant it enforces
 * across modes is:
 *
 *   Visibility is universal. Every agent — regardless of mode,
 *   regardless of whether the agent's preset enables the `note_open`
 *   / `note_close` tools — sees the same `## Open Notes` block.
 *
 * These tests pin the block format (`## Open Notes ...\n- [id] text`)
 * and the failure modes (missing adapter → empty; adapter throws →
 * empty; closed entries filtered; legacy entries without status
 * default to open).
 */

import { describe, expect, test } from '@jest/globals';
import {
    readOpenNotes,
    renderOpenNotesBlock,
    loadOpenNotesBlock,
    buildOpenNotesRuntimeStateMessage,
} from '../../public/scripts/extensions/orchestrator/open-notes-injection.js';

describe('readOpenNotes', () => {
    test('returns [] when contextForNotes is null / undefined / bare', async () => {
        expect(await readOpenNotes(null)).toEqual([]);
        expect(await readOpenNotes(undefined)).toEqual([]);
        expect(await readOpenNotes({})).toEqual([]);
        expect(await readOpenNotes({ __floorStateForNotes: {} })).toEqual([]);
    });

    test('filters closed entries; legacy entries without status default to open', async () => {
        const ctx = {
            __floorStateForNotes: {
                listAcrossFloors: async () => ([
                    { id: 'a', text: 'open thread', status: 'open' },
                    { id: 'b', text: 'done thread', status: 'closed', closure_reason: 'paid off' },
                    { id: 'c', text: 'legacy thread' },
                ]),
            },
        };
        expect(await readOpenNotes(ctx)).toEqual([
            { id: 'a', text: 'open thread' },
            { id: 'c', text: 'legacy thread' },
        ]);
    });

    test('returns [] when listAcrossFloors throws', async () => {
        const ctx = {
            __floorStateForNotes: {
                listAcrossFloors: async () => { throw new Error('boom'); },
            },
        };
        expect(await readOpenNotes(ctx)).toEqual([]);
    });

    test('returns [] when listAcrossFloors returns a non-array', async () => {
        const ctx = {
            __floorStateForNotes: {
                listAcrossFloors: async () => null,
            },
        };
        expect(await readOpenNotes(ctx)).toEqual([]);
    });
});

describe('renderOpenNotesBlock', () => {
    test('returns empty string for empty / null / undefined list', () => {
        expect(renderOpenNotesBlock([])).toBe('');
        expect(renderOpenNotesBlock(null)).toBe('');
        expect(renderOpenNotesBlock(undefined)).toBe('');
    });

    test('renders header + one `- [id] text` line per entry', () => {
        const out = renderOpenNotesBlock([
            { id: 'o_a3f2', text: 'planted key' },
            { id: 'o_b8c1', text: 'sanctum oath' },
        ]);
        expect(out).toContain('## Open Notes');
        expect(out).toContain('- [o_a3f2] planted key');
        expect(out).toContain('- [o_b8c1] sanctum oath');
        // Format contract: header first, then entries in order.
        const lines = out.split('\n');
        expect(lines[0]).toMatch(/^## Open Notes/);
        expect(lines[1]).toBe('- [o_a3f2] planted key');
        expect(lines[2]).toBe('- [o_b8c1] sanctum oath');
    });

    test('drops entries that have neither id nor text', () => {
        const out = renderOpenNotesBlock([
            { id: 'a', text: 'good' },
            { id: '', text: '' },
            { id: 'b', text: 'also good' },
        ]);
        expect(out).toContain('- [a] good');
        expect(out).toContain('- [b] also good');
        expect(out.split('\n').filter(l => l.startsWith('- ')).length).toBe(2);
    });

    test('renders empty when every entry is a phantom (nothing to say)', () => {
        expect(renderOpenNotesBlock([{ id: '', text: '' }, { id: '', text: '' }])).toBe('');
    });
});

describe('loadOpenNotesBlock', () => {
    test('composes read + render in one shot', async () => {
        const ctx = {
            __floorStateForNotes: {
                listAcrossFloors: async () => ([
                    { id: 'x', text: 'thread x', status: 'open' },
                    { id: 'y', text: 'thread y', status: 'closed' },
                ]),
            },
        };
        const out = await loadOpenNotesBlock(ctx);
        expect(out).toContain('## Open Notes');
        expect(out).toContain('- [x] thread x');
        expect(out).not.toContain('thread y');
    });

    test('empty string when no adapter is mounted', async () => {
        expect(await loadOpenNotesBlock(null)).toBe('');
        expect(await loadOpenNotesBlock({})).toBe('');
    });

    test('empty string when all notes are closed', async () => {
        const ctx = {
            __floorStateForNotes: {
                listAcrossFloors: async () => ([
                    { id: 'c1', text: 'done1', status: 'closed' },
                    { id: 'c2', text: 'done2', status: 'closed' },
                ]),
            },
        };
        expect(await loadOpenNotesBlock(ctx)).toBe('');
    });
});

describe('buildOpenNotesRuntimeStateMessage', () => {
    test('returns null when there is nothing to inject', async () => {
        expect(await buildOpenNotesRuntimeStateMessage(null)).toBeNull();
        expect(await buildOpenNotesRuntimeStateMessage({})).toBeNull();
        expect(await buildOpenNotesRuntimeStateMessage({
            __floorStateForNotes: {
                listAcrossFloors: async () => ([{ id: 'c', text: 'x', status: 'closed' }]),
            },
        })).toBeNull();
    });

    test('wraps the block into a user-role <runtime_state> message', async () => {
        const ctx = {
            __floorStateForNotes: {
                listAcrossFloors: async () => ([{ id: 'a', text: 'live thread', status: 'open' }]),
            },
        };
        const msg = await buildOpenNotesRuntimeStateMessage(ctx);
        expect(msg).not.toBeNull();
        expect(msg.role).toBe('user');
        expect(msg.content.startsWith('<runtime_state>')).toBe(true);
        expect(msg.content.endsWith('</runtime_state>')).toBe(true);
        expect(msg.content).toContain('## Open Notes');
        expect(msg.content).toContain('- [a] live thread');
    });
});
