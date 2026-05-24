/**
 * Tests for the loop-mode AI Iteration Studio helpers.
 *
 * These exercise the pure pieces extracted from `main.js` so the
 * iteration session can swap between spec / agenda / loop modes
 * without DOM dependencies leaking into tests:
 *
 *   - LOOP_ITERATION_CONTRACT_LINES — the contract block appended to
 *     the user-facing iteration system prompt when editing a loop
 *     profile. Asserting the wording is the closest unit-level
 *     equivalent of "prompt template picker" coverage; the picker
 *     itself in `main.js::buildAiIterationSystemPrompt` simply
 *     concatenates the base prompt with these lines when
 *     `isLoopIterationSession(session)`.
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
    const text = LOOP_ITERATION_CONTRACT_LINES.join('\n');

    test('declares the loop-profile editing contract up-front', () => {
        expect(LOOP_ITERATION_CONTRACT_LINES[0]).toBe('Iteration mode contract (loop profile):');
    });

    test('mentions every editable scalar field by its on-the-wire name', () => {
        expect(text).toMatch(/system_prompt/);
        expect(text).toMatch(/apiPresetName/);
        expect(text).toMatch(/promptPresetName/);
        expect(text).toMatch(/max_rounds/);
        expect(text).toMatch(/wall_clock_budget_ms/);
    });

    test('mentions every tool flag by its dotted path so the AI can target them', () => {
        expect(text).toMatch(/tools\.note\.open/);
        expect(text).toMatch(/tools\.note\.close/);
        expect(text).toMatch(/tools\.chat\.read_range/);
        expect(text).toMatch(/tools\.chat\.search/);
        expect(text).toMatch(/tools\.lorebook\.search/);
        expect(text).toMatch(/tools\.lorebook\.get/);
        expect(text).toMatch(/tools\.memory\.list_candidates/);
        expect(text).toMatch(/tools\.memory\.edge_summary/);
        expect(text).toMatch(/tools\.memory\.node_brief/);
        expect(text).toMatch(/tools\.memory\.expand_seeds/);
        expect(text).toMatch(/tools\.memory\.keyword_search/);
        expect(text).toMatch(/tools\.memory\.vector_search/);
        expect(text).toMatch(/tools\.memory\.find_by_name/);
        expect(text).toMatch(/tools\.memory\.compaction_candidates/);
        expect(text).toMatch(/tools\.memory\.node_create/);
        expect(text).toMatch(/tools\.memory\.node_edit/);
        expect(text).toMatch(/tools\.memory\.node_delete/);
        expect(text).toMatch(/tools\.memory\.link_upsert/);
        expect(text).toMatch(/tools\.memory\.link_delete/);
        expect(text).toMatch(/tools\.memory\.compact_nodes/);
        expect(text).toMatch(/tools\.memory\.schema/);
        expect(text).toMatch(/tools\.search\.search/);
        expect(text).toMatch(/tools\.search\.visit/);
    });

    test('forbids disabling the finalize terminator', () => {
        // The contract must explicitly tell the AI that finalize is
        // always on — sanitizer coerces it back, but the AI should not
        // even attempt to flip it.
        expect(text).toMatch(/finalize tool is always enabled/);
    });

    test('points at the dedicated patch tool name', () => {
        expect(text).toMatch(/luker_orch_set_loop_profile/);
    });

    test('directs the AI to call continue / finalize iteration tools as appropriate', () => {
        expect(text).toMatch(/luker_orch_continue_iteration/);
        expect(text).toMatch(/luker_orch_finalize_iteration/);
    });

    test('avoids spec-mode-only language about stages, nodes, or presets', () => {
        // Negative coverage: the loop-mode prompt must not claim there
        // are stages / nodes / presets to manage. Loop is single-agent.
        expect(text).not.toMatch(/luker_orch_set_stage/);
        expect(text).not.toMatch(/luker_orch_set_node/);
        expect(text).not.toMatch(/luker_orch_set_preset/);
    });

    test('documents finalize-sticky ordering so the LLM knows finalize wins over continue in the same round', () => {
        // Sticky-finalize: if the model calls both continue + finalize in
        // a single round, the popup's onControlCall handler treats finalize
        // as the terminator and ends the loop. This assertion guards the
        // doc line that surfaces the rule in the prompt itself so the
        // model can plan accordingly.
        expect(text.toLowerCase()).toMatch(/finalize wins/);
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
        expect(after.tools.memory.list_candidates).toBe(false);
        expect(after.tools.memory.edge_summary).toBe(false);
        expect(after.tools.memory.node_brief).toBe(false);
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

    test('numeric clamps from sanitizer apply to patched fields', () => {
        // max_rounds is clamped into [1, 50]; wall_clock_budget_ms is
        // floored at 10000ms by sanitizeLoopProfile. The patch helper
        // does no clamping of its own — it relies on sanitizer.
        const out = applyLoopProfilePatchArgs(baseProfile(), {
            max_rounds: 9999,
            wall_clock_budget_ms: 100,
        });
        expect(out.max_rounds).toBe(50);
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
});
