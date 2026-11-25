/**
 * Tests for the loop-mode AI Iteration Studio helpers.
 *
 * These exercise the pure pieces extracted from `main.js` so the
 * iteration session can swap between spec / agenda / loop modes
 * without DOM dependencies leaking into tests:
 *
 *   - LOOP_ITERATION_CONTRACT_LINES — structural shape check (non-empty
 *     array of non-empty strings appended when editing a loop profile).
 *   - applyLoopProfilePatchArgs — partial-merge contract: only fields
 *     the AI passes are mutated, omitted fields inherit from the
 *     current profile, and tools.finalize is always coerced to true
 *     by sanitizeLoopProfile regardless of input.
 */

import { describe, test, expect } from '@jest/globals';

import {
    LOOP_ITERATION_CONTRACT_LINES,
    applyLoopProfilePatchArgs,
} from '../../public/scripts/extensions/orchestrator/loop-iteration.js';
import { sanitizeLoopProfile } from '../../public/scripts/extensions/orchestrator/persistence.js';

describe('LOOP_ITERATION_CONTRACT_LINES', () => {
    test('exports a non-empty array of strings containing contract content', () => {
        expect(Array.isArray(LOOP_ITERATION_CONTRACT_LINES)).toBe(true);
        expect(LOOP_ITERATION_CONTRACT_LINES.length).toBeGreaterThan(0);
        for (const line of LOOP_ITERATION_CONTRACT_LINES) {
            expect(typeof line).toBe('string');
        }
        expect(LOOP_ITERATION_CONTRACT_LINES.some(line => line.trim().length > 0)).toBe(true);
    });
});

describe('applyLoopProfilePatchArgs partial-merge contract', () => {
    function baseProfile(overrides = {}) {
        return sanitizeLoopProfile({
            system_prompt: 'You are an assistant.',
            max_rounds: 12,
            wall_clock_budget_ms: 60000,
            apiPresetName: 'baseline-api',
            promptPresetName: 'baseline-preset',
            tools: {
                note: { open: true, close: true },
                chat: { read_range: true, search: true },
                lorebook: { search: true, get: true },
                memory: {
                    list_candidates: true, edge_summary: true, node_brief: true,
                    expand_seeds: true, schema: true,
                    keyword_search: true, vector_search: true, find_by_name: true,
                    compaction_candidates: true,
                    node_create: true, node_edit: true, node_delete: true,
                    link_upsert: true, link_delete: true, compact_nodes: true,
                },
            },
            ...overrides,
        });
    }

    test('returning a fully-sanitized V3 profile envelope', () => {
        const out = applyLoopProfilePatchArgs(baseProfile(), { max_rounds: 7 });
        // Sanitizer always returns the canonical shape: mode === 'loop',
        // tools.finalize === true, capsule_inject hydrated.
        expect(out.mode).toBe('loop');
        expect(out.tools.finalize).toBe(true);
        expect(out.capsule_inject).toEqual(expect.objectContaining({ position: expect.any(String) }));
    });

    test('omitted fields inherit from the current profile', () => {
        const before = baseProfile();
        const after = applyLoopProfilePatchArgs(before, { max_rounds: 9 });
        expect(after.max_rounds).toBe(9);
        // System prompt + presets + every tool flag should be unchanged.
        expect(after.system_prompt).toBe(before.system_prompt);
        expect(after.apiPresetName).toBe(before.apiPresetName);
        expect(after.promptPresetName).toBe(before.promptPresetName);
        expect(after.wall_clock_budget_ms).toBe(before.wall_clock_budget_ms);
        expect(after.tools).toEqual(before.tools);
    });

    test('tool-flag patches mutate only the keys the AI passes', () => {
        const before = baseProfile();
        const after = applyLoopProfilePatchArgs(before, {
            tools: {
                lorebook: { search: false },
                memory: { list_candidates: false, edge_summary: false, node_brief: false },
            },
        });
        // Touched flags flip…
        expect(after.tools.lorebook.search).toBe(false);
        // memory.* flags translate into custom.memory_<verb> after the
        // namespace was moved to Layer-2 in Task 4.5.
        expect(after.tools.custom.memory_list_candidates).toBe(false);
        expect(after.tools.custom.memory_edge_summary).toBe(false);
        expect(after.tools.custom.memory_node_brief).toBe(false);
        // …while siblings the AI did not name remain at their previous
        // value (lorebook.get is still true, all chat flags still true).
        expect(after.tools.lorebook.get).toBe(true);
        expect(after.tools.chat.read_range).toBe(true);
        expect(after.tools.chat.search).toBe(true);
        expect(after.tools.note.open).toBe(true);
    });

    test('note.open / note.close patches actually take effect', () => {
        // Regression guard: the iteration contract advertises
        // `tools.note.open` / `tools.note.close` as editable; the merge
        // function must look for those exact keys (not the pre-rename
        // `note.add` / `note.delete`).
        const before = baseProfile();
        const after = applyLoopProfilePatchArgs(before, {
            tools: { note: { open: false, close: false } },
        });
        expect(after.tools.note.open).toBe(false);
        expect(after.tools.note.close).toBe(false);
    });

    test('attempting to disable finalize is silently ignored by the sanitizer', () => {
        const after = applyLoopProfilePatchArgs(baseProfile(), {
            tools: { finalize: false },
        });
        // sanitizeLoopProfile always coerces finalize back to true; the
        // patch helper does not even forward the field, but this guards
        // against future regressions.
        expect(after.tools.finalize).toBe(true);
    });

    test('numeric floors from sanitizer apply to patched fields', () => {
        // max_rounds is floored at 1 and wall_clock_budget_ms is floored
        // at 10000ms by sanitizeLoopProfile. The patch helper does no
        // clamping of its own — it relies on sanitizer. There is no
        // upper bound: large values pass through unchanged.
        const out = applyLoopProfilePatchArgs(baseProfile(), {
            max_rounds: 9999,
            wall_clock_budget_ms: 100,
        });
        expect(out.max_rounds).toBe(9999);
        expect(out.wall_clock_budget_ms).toBe(10000);
    });

    test('null / undefined args are tolerated and produce a no-op snapshot', () => {
        const before = baseProfile();
        const afterUndef = applyLoopProfilePatchArgs(before, undefined);
        const afterNull = applyLoopProfilePatchArgs(before, null);
        const afterEmpty = applyLoopProfilePatchArgs(before, {});
        // The sanitizer rebuilds the structuredClone-fresh `tools` and
        // `capsule_inject` envelopes, so identity equality is not
        // useful; deep-equal is.
        expect(afterUndef).toEqual(before);
        expect(afterNull).toEqual(before);
        expect(afterEmpty).toEqual(before);
    });

    test('round-tripped patch result is itself accepted by sanitizeLoopProfile', () => {
        // A loop iteration patch must always be sanitizer-clean, so the
        // editor can write it straight to settings. Re-feeding the
        // result must be a fixed point (deep-equal to itself).
        const patched = applyLoopProfilePatchArgs(baseProfile(), {
            system_prompt: 'You are a research agent.',
            max_rounds: 30,
            tools: { lorebook: { search: false } },
        });
        expect(sanitizeLoopProfile(patched)).toEqual(patched);
    });

    // ──────────────────────────────────────────────────────────────────
    // Strict arg validation (anti-silent-drop). Each of these cases used
    // to silently fall back to the current value via a typeof guard,
    // collapsing onto the iter-studio's misleading "already matches"
    // noop. They now throw so the executor's catch arm can produce a
    // real `{ok:false, error:'invalid_args', detail}` tool reply.
    // ──────────────────────────────────────────────────────────────────
    test('throws invalid_args when system_prompt is the wrong type', () => {
        expect(() => applyLoopProfilePatchArgs(baseProfile(), { system_prompt: 42 }))
            .toThrow(/invalid_args.*system_prompt.*number/);
        expect(() => applyLoopProfilePatchArgs(baseProfile(), { system_prompt: null }))
            .toThrow(/invalid_args.*system_prompt/);
    });

    test('throws invalid_args when apiPresetName / promptPresetName are not strings', () => {
        expect(() => applyLoopProfilePatchArgs(baseProfile(), { apiPresetName: 5 }))
            .toThrow(/invalid_args.*apiPresetName/);
        expect(() => applyLoopProfilePatchArgs(baseProfile(), { promptPresetName: {} }))
            .toThrow(/invalid_args.*promptPresetName/);
    });

    test('throws invalid_args when max_rounds / wall_clock_budget_ms are not numbers', () => {
        expect(() => applyLoopProfilePatchArgs(baseProfile(), { max_rounds: '12' }))
            .toThrow(/invalid_args.*max_rounds/);
        expect(() => applyLoopProfilePatchArgs(baseProfile(), { wall_clock_budget_ms: 'soon' }))
            .toThrow(/invalid_args.*wall_clock_budget_ms/);
        // Non-finite numbers (NaN / Infinity) are also rejected.
        expect(() => applyLoopProfilePatchArgs(baseProfile(), { max_rounds: NaN }))
            .toThrow(/invalid_args.*max_rounds/);
    });

    test('throws invalid_args when tools is not an object', () => {
        expect(() => applyLoopProfilePatchArgs(baseProfile(), { tools: 'enable_all' }))
            .toThrow(/invalid_args.*tools/);
        expect(() => applyLoopProfilePatchArgs(baseProfile(), { tools: null }))
            .toThrow(/invalid_args.*tools/);
        expect(() => applyLoopProfilePatchArgs(baseProfile(), { tools: [] }))
            .toThrow(/invalid_args.*tools/);
    });

    test('throws invalid_args when a tool-namespace patch carries a non-boolean flag value', () => {
        expect(() => applyLoopProfilePatchArgs(baseProfile(), { tools: { note: { open: 'yes' } } }))
            .toThrow(/invalid_args.*note\.open.*boolean/);
        expect(() => applyLoopProfilePatchArgs(baseProfile(), { tools: { lorebook: { search: 1 } } }))
            .toThrow(/invalid_args.*lorebook\.search.*boolean/);
    });

    test('throws invalid_args when a tool-namespace value itself is wrong-shape', () => {
        expect(() => applyLoopProfilePatchArgs(baseProfile(), { tools: { note: 'all' } }))
            .toThrow(/invalid_args.*tools\.note/);
    });

    test('still inherits silently when a key is simply absent (partial-merge semantics survive)', () => {
        // Regression guard: stricter type checks must NOT make partial
        // merge harder. Absent keys still inherit from current.
        const before = baseProfile();
        const after = applyLoopProfilePatchArgs(before, { max_rounds: 7 });
        expect(after.system_prompt).toBe(before.system_prompt);
        expect(after.apiPresetName).toBe(before.apiPresetName);
        expect(after.tools).toEqual(before.tools);
    });
});
