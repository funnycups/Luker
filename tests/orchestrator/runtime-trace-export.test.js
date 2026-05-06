/**
 * Unit tests for runtime-trace-export.js — pure JSONL serialization.
 *
 * The module is intentionally isolated from runtime-trace.js to keep the
 * Jest runner from pulling `lib.js` transitively through the trace module
 * graph. It accepts a plain events array (whatever shape the trace stored)
 * and produces a string suitable for download or filesystem persistence.
 */

import { describe, it, expect } from '@jest/globals';

import {
    exportRunTraceAsJsonl,
} from '../../public/scripts/extensions/orchestrator/runtime-trace-export.js';

describe('exportRunTraceAsJsonl', () => {
    it('returns an empty string when given an empty array', () => {
        expect(exportRunTraceAsJsonl([])).toBe('');
    });

    it('returns an empty string for non-array input (defensive)', () => {
        expect(exportRunTraceAsJsonl(null)).toBe('');
        expect(exportRunTraceAsJsonl(undefined)).toBe('');
        // @ts-ignore intentional bad input
        expect(exportRunTraceAsJsonl('not an array')).toBe('');
    });

    it('serializes a single event as one JSONL line ending with newline', () => {
        const out = exportRunTraceAsJsonl([
            { seq: 1, at: '2026-05-06T00:00:00.000Z', type: 'run_started', mode: 'loop' },
        ]);
        const lines = out.split('\n');
        // trailing newline so each line is terminated → split yields one extra empty
        expect(lines).toEqual([
            JSON.stringify({ seq: 1, at: '2026-05-06T00:00:00.000Z', type: 'run_started', mode: 'loop' }),
            '',
        ]);
    });

    it('serializes multiple events in input order, one per line', () => {
        const events = [
            { type: 'run_started', mode: 'loop', time: 1 },
            { type: 'llm_request', round: 1, message_count: 2 },
            { type: 'llm_response', round: 1, tool_calls: 1, has_text: false },
            { type: 'tool_call', round: 1, name: 'finalize' },
            { type: 'run_finished', status: 'completed', total_rounds: 1 },
        ];
        const out = exportRunTraceAsJsonl(events);
        const lines = out.split('\n').filter(Boolean);
        expect(lines).toHaveLength(5);
        expect(JSON.parse(lines[0]).type).toBe('run_started');
        expect(JSON.parse(lines[1]).type).toBe('llm_request');
        expect(JSON.parse(lines[1]).message_count).toBe(2);
        expect(JSON.parse(lines[2]).type).toBe('llm_response');
        expect(JSON.parse(lines[3]).type).toBe('tool_call');
        expect(JSON.parse(lines[4]).type).toBe('run_finished');
    });

    it('encodes special characters (newlines, quotes, unicode) without breaking JSONL framing', () => {
        const events = [
            { type: 'tool_result', payload: 'line1\nline2\n"quoted"\té' },
            { type: 'tool_error', error: 'Bad input: "x"\nDetails:\nfoo' },
        ];
        const out = exportRunTraceAsJsonl(events);
        const lines = out.split('\n').filter(Boolean);
        expect(lines).toHaveLength(2);
        // Each line MUST be valid JSON on its own — newlines inside payloads
        // are escaped by JSON.stringify, never literal in the JSONL stream.
        const parsed0 = JSON.parse(lines[0]);
        expect(parsed0.payload).toBe('line1\nline2\n"quoted"\té');
        const parsed1 = JSON.parse(lines[1]);
        expect(parsed1.error).toBe('Bad input: "x"\nDetails:\nfoo');
    });

    it('drops events that fail JSON.stringify (e.g. cyclic refs) but keeps the rest', () => {
        const cyc = { type: 'cyclic' };
        cyc.self = cyc;
        const events = [
            { type: 'first' },
            cyc,
            { type: 'third' },
        ];
        const out = exportRunTraceAsJsonl(events);
        const lines = out.split('\n').filter(Boolean);
        expect(lines).toHaveLength(2);
        expect(JSON.parse(lines[0]).type).toBe('first');
        expect(JSON.parse(lines[1]).type).toBe('third');
    });
});
