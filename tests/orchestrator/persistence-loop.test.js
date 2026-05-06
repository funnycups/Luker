/**
 * V3 loop profile schema + sanitizer tests.
 *
 * Covers the new `loop` execution mode added alongside V1 (spec) / V2 (agenda):
 *
 *   - default field values (mode / system_prompt / tool flags / max_rounds /
 *     wall_clock_budget_ms / capsule_inject)
 *   - max_rounds clamped to [1, 50]
 *   - wall_clock_budget_ms floored at 10000ms
 *   - tools.finalize forced to true even if input passes false
 *   - mode field forced to 'loop' regardless of input
 *
 * Sibling sanitizers (sanitizeSpec / sanitizeAgendaWorkingProfile) are
 * untouched by this layer; this file only exercises sanitizeLoopProfile.
 */

import { describe, test, expect } from '@jest/globals';

import {
    ORCH_EXECUTION_MODE_LOOP,
    sanitizeLoopProfile,
} from '../../public/scripts/extensions/orchestrator/persistence.js';

describe('ORCH_EXECUTION_MODE_LOOP', () => {
    test('exposes the loop mode literal', () => {
        expect(ORCH_EXECUTION_MODE_LOOP).toBe('loop');
    });
});

describe('sanitizeLoopProfile defaults', () => {
    test('returns a fully-populated V3 profile when input is empty', () => {
        const out = sanitizeLoopProfile({});
        expect(out.mode).toBe(ORCH_EXECUTION_MODE_LOOP);
        expect(out.apiPresetName).toBe('');
        expect(out.promptPresetName).toBe('');
        expect(out.system_prompt).toBe('');
        expect(out.tools.note.add).toBe(true);
        expect(out.tools.chat.read_range).toBe(true);
        expect(out.tools.chat.search).toBe(true);
        expect(out.tools.lorebook.search).toBe(true);
        expect(out.tools.lorebook.get).toBe(true);
        expect(out.tools.memory.search).toBe(true);
        expect(out.tools.memory.list_recent).toBe(true);
        expect(out.tools.memory.get).toBe(true);
        expect(out.tools.finalize).toBe(true);
        expect(out.max_rounds).toBe(20);
        expect(out.wall_clock_budget_ms).toBe(300000);
        expect(out.capsule_inject).toMatchObject({
            position: 'atDepth',
            depth: 0,
            role: 'system',
            customInstruction: '',
        });
    });

    test('returns the default profile shape when input is null/undefined', () => {
        const fromNull = sanitizeLoopProfile(null);
        const fromUndefined = sanitizeLoopProfile(undefined);
        expect(fromNull.mode).toBe(ORCH_EXECUTION_MODE_LOOP);
        expect(fromNull.max_rounds).toBe(20);
        expect(fromUndefined.mode).toBe(ORCH_EXECUTION_MODE_LOOP);
        expect(fromUndefined.tools.finalize).toBe(true);
    });

    test('preserves caller-supplied system_prompt / apiPresetName / promptPresetName', () => {
        const out = sanitizeLoopProfile({
            mode: 'loop',
            apiPresetName: 'my-api',
            promptPresetName: 'my-preset',
            system_prompt: 'You are a research agent.',
        });
        expect(out.apiPresetName).toBe('my-api');
        expect(out.promptPresetName).toBe('my-preset');
        expect(out.system_prompt).toBe('You are a research agent.');
    });

    test('coerces non-string preset names to empty strings', () => {
        const out = sanitizeLoopProfile({ apiPresetName: 42, promptPresetName: null, system_prompt: undefined });
        expect(out.apiPresetName).toBe('42');
        expect(out.promptPresetName).toBe('');
        expect(out.system_prompt).toBe('');
    });
});

describe('sanitizeLoopProfile mode coercion', () => {
    test("forces mode to 'loop' even when input declares a different mode", () => {
        expect(sanitizeLoopProfile({ mode: 'spec' }).mode).toBe('loop');
        expect(sanitizeLoopProfile({ mode: 'agenda' }).mode).toBe('loop');
        expect(sanitizeLoopProfile({ mode: '' }).mode).toBe('loop');
        expect(sanitizeLoopProfile({ mode: 'whatever' }).mode).toBe('loop');
    });
});

describe('sanitizeLoopProfile max_rounds clamping', () => {
    test('clamps zero / negative input to the floor (1)', () => {
        expect(sanitizeLoopProfile({ max_rounds: 0 }).max_rounds).toBe(1);
        expect(sanitizeLoopProfile({ max_rounds: -50 }).max_rounds).toBe(1);
    });

    test('clamps oversized input to the hard cap (50)', () => {
        expect(sanitizeLoopProfile({ max_rounds: 999 }).max_rounds).toBe(50);
        expect(sanitizeLoopProfile({ max_rounds: 51 }).max_rounds).toBe(50);
    });

    test('passes valid in-range values through unchanged', () => {
        expect(sanitizeLoopProfile({ max_rounds: 25 }).max_rounds).toBe(25);
        expect(sanitizeLoopProfile({ max_rounds: 1 }).max_rounds).toBe(1);
        expect(sanitizeLoopProfile({ max_rounds: 50 }).max_rounds).toBe(50);
    });

    test('floors fractional values', () => {
        expect(sanitizeLoopProfile({ max_rounds: 12.9 }).max_rounds).toBe(12);
    });

    test('falls back to default on non-numeric / NaN input', () => {
        expect(sanitizeLoopProfile({ max_rounds: 'lots' }).max_rounds).toBe(20);
        expect(sanitizeLoopProfile({ max_rounds: NaN }).max_rounds).toBe(20);
        expect(sanitizeLoopProfile({ max_rounds: null }).max_rounds).toBe(20);
    });
});

describe('sanitizeLoopProfile wall_clock_budget_ms floor', () => {
    test('raises sub-floor input up to 10000ms', () => {
        expect(sanitizeLoopProfile({ wall_clock_budget_ms: 5000 }).wall_clock_budget_ms).toBe(10000);
        expect(sanitizeLoopProfile({ wall_clock_budget_ms: 0 }).wall_clock_budget_ms).toBe(10000);
        expect(sanitizeLoopProfile({ wall_clock_budget_ms: -1 }).wall_clock_budget_ms).toBe(10000);
    });

    test('passes valid values >= 10000 through unchanged', () => {
        expect(sanitizeLoopProfile({ wall_clock_budget_ms: 10000 }).wall_clock_budget_ms).toBe(10000);
        expect(sanitizeLoopProfile({ wall_clock_budget_ms: 600000 }).wall_clock_budget_ms).toBe(600000);
    });

    test('falls back to default (300000) on non-numeric input', () => {
        expect(sanitizeLoopProfile({ wall_clock_budget_ms: 'fast' }).wall_clock_budget_ms).toBe(300000);
        expect(sanitizeLoopProfile({ wall_clock_budget_ms: null }).wall_clock_budget_ms).toBe(300000);
    });
});

describe('sanitizeLoopProfile tools handling', () => {
    test('forces tools.finalize: true even if user passes false', () => {
        const out = sanitizeLoopProfile({ tools: { finalize: false } });
        expect(out.tools.finalize).toBe(true);
    });

    test('keeps tools.finalize: true regardless of any other shape', () => {
        expect(sanitizeLoopProfile({ tools: { finalize: 'no' } }).tools.finalize).toBe(true);
        expect(sanitizeLoopProfile({ tools: { finalize: 0 } }).tools.finalize).toBe(true);
        expect(sanitizeLoopProfile({ tools: null }).tools.finalize).toBe(true);
        expect(sanitizeLoopProfile({}).tools.finalize).toBe(true);
    });

    test('respects user-disabled flags for non-finalize tools', () => {
        const out = sanitizeLoopProfile({
            tools: {
                note: { add: false },
                chat: { read_range: false, search: false },
                lorebook: { search: false, get: false },
                memory: { search: false, list_recent: false, get: false },
                finalize: false,
            },
        });
        expect(out.tools.note.add).toBe(false);
        expect(out.tools.chat.read_range).toBe(false);
        expect(out.tools.chat.search).toBe(false);
        expect(out.tools.lorebook.search).toBe(false);
        expect(out.tools.lorebook.get).toBe(false);
        expect(out.tools.memory.search).toBe(false);
        expect(out.tools.memory.list_recent).toBe(false);
        expect(out.tools.memory.get).toBe(false);
        // finalize remains forced on
        expect(out.tools.finalize).toBe(true);
    });

    test('defaults missing tool flags to true', () => {
        const out = sanitizeLoopProfile({ tools: { chat: { read_range: false } } });
        // chat.read_range explicitly disabled, but chat.search defaults to true
        expect(out.tools.chat.read_range).toBe(false);
        expect(out.tools.chat.search).toBe(true);
        // unmentioned namespaces default to all-true
        expect(out.tools.note.add).toBe(true);
        expect(out.tools.lorebook.search).toBe(true);
        expect(out.tools.lorebook.get).toBe(true);
        expect(out.tools.memory.search).toBe(true);
        expect(out.tools.memory.list_recent).toBe(true);
        expect(out.tools.memory.get).toBe(true);
    });
});

describe('sanitizeLoopProfile capsule_inject', () => {
    test('merges caller-supplied capsule_inject fields over the defaults', () => {
        const out = sanitizeLoopProfile({
            capsule_inject: { depth: 4, role: 'user', customInstruction: 'hi' },
        });
        expect(out.capsule_inject).toEqual({
            position: 'atDepth',
            depth: 4,
            role: 'user',
            customInstruction: 'hi',
        });
    });

    test('returns the defaults when capsule_inject is missing', () => {
        const out = sanitizeLoopProfile({});
        expect(out.capsule_inject).toEqual({
            position: 'atDepth',
            depth: 0,
            role: 'system',
            customInstruction: '',
        });
    });
});
